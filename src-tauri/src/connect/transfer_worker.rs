//! Private one-shot E framing. Database admission/dispatch is not yet connected.
//! In particular, a worker reply never creates a database or policy capability.
use super::codec::ChildIo;
use crate::connect_resources::{WorkingCharge, WorkingLease};
use crate::core::db_state::ChatWorkLifetime;
use serde::Deserialize;
use std::sync::Arc;
use tokio::process::Command;
use tokio::time::Instant;

type Result<T> = std::result::Result<T, &'static str>;
const CONTROL: usize = 4096;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Hello {
    pub(super) version: String,
    pub(super) portable_contract_sha256: String,
    pub(super) preparation_set_sha256: String,
}

// No Deserialize and deliberately no production constructor until the real DB
// owners provide the scoped handles. START bytes are not an authority token.
pub(super) struct AdmittedEWork {
    pub(super) generation: u64,
    pub(super) job: u64,
    pub(super) arena: u64,
    pub(super) child_units: u64,
    pub(super) detection_units: u64,
    pub(super) start: [u8; CONTROL],
    pub(super) start_len: usize,
    pub(super) expected: Hello,
    pub(super) _database: ChatWorkLifetime,
    pub(super) _working: Arc<WorkingLease>,
    pub(super) _charges: Vec<WorkingCharge>,
}

#[derive(PartialEq, Eq)]
enum Phase { Hello, Admitted, Running, Dispatch, Finished, Failed }
struct Owned {
    io: ChildIo,
    // This includes native scratch/control, Child arena and detection charges.
    // They must all be reserved by the DB admission owner before spawn/GRANT.
    work: AdmittedEWork,
}

pub(crate) struct TransferWorker {
    owned: Option<Owned>,
    phase: Phase,
    normalized: Option<(Vec<u8>,serde_json::Value,Vec<u8>,WorkingCharge)>,
    database: Option<ChatWorkLifetime>,
    imported:Option<crate::db::inactive_storage::SealedStorage>,
    imported_metadata:Option<serde_json::Value>,
    prepared_draft:Option<std::collections::BTreeMap<String,Vec<serde_json::Value>>>,
    native_request:Option<(crate::ai::types::AiChatRequest,serde_json::Value,Vec<u8>)>,
}
impl TransferWorker {
    pub(super) fn spawn(mut command: Command, work: AdmittedEWork, generation: u64) -> Result<Self> {
        if work.generation != generation { return Err("transfer_generation"); }
        if work.job == 0 || work.arena == 0 || work.start_len == 0 || work.start_len > CONTROL
            || work.child_units == 0 || work.detection_units == 0
            || work.child_units.checked_add(work.detection_units).filter(|n| *n <= MAX_SAFE).is_none()
        { return Err("transfer_admission"); }
        command.arg("connect-transfer");
        let io = ChildIo::spawn(command)?;
        Ok(Self { owned: Some(Owned { io, work }), phase: Phase::Hello, normalized:None, database:None, imported:None, imported_metadata:None, prepared_draft:None, native_request:None })
    }
    async fn hello(&mut self) -> Result<()> {
        if self.phase != Phase::Hello { return Err("transfer_state"); }
        // Cancellation or parse failure cannot leave this state retryable.
        self.phase = Phase::Failed;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let h = owned.io.next(|_| CONTROL, |h| h.exact(1, h.length, 0, 0, 0) && h.length > 0).await?;
        let result = serde_json::from_slice::<Hello>(&owned.io.scratch[..h.length])
            .map_err(|_| "transfer_identity");
        owned.io.scratch.fill(0);
        if result? != owned.work.expected { return Err("transfer_identity"); }
        self.phase = Phase::Admitted;
        Ok(())
    }
    // Caller must freshly revalidate the native DB/policy scope after HELLO and
    // before this effect. That concrete caller remains blocked on the DB ports.
    async fn begin(&mut self, generation: u64) -> Result<()> {
        if self.phase != Phase::Admitted { return Err("transfer_state"); }
        self.phase = Phase::Failed;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let w = &mut owned.work;
        if generation != w.generation { return Err("transfer_generation"); }
        owned.io.send(2, w.job, 0, 0, &w.start[..w.start_len]).await?;
        w.start.fill(0);
        let mut grant = [0u8; 32];
        grant[..8].copy_from_slice(&(w.child_units + w.detection_units).to_be_bytes());
        grant[16..24].copy_from_slice(&w.arena.to_be_bytes());
        grant[28] = 3;
        owned.io.send(3, w.job, w.arena, 0, &grant).await?;
        self.phase = Phase::Running;
        Ok(())
    }
    // Only the E dispatcher may consume these bytes. Opcodes 1..7 are native
    // port calls, not codec operations 1..9; they confer no authority themselves.
    // The borrow forbids another read or retirement while the request is used.
    async fn request(&mut self) -> Result<&[u8]> {
        if self.phase != Phase::Running { return Err("transfer_state"); }
        self.phase = Phase::Failed;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let job = owned.work.job;
        let h = owned.io.next(|_| CONTROL, |h| h.exact(2, h.length, job, 0, 0) && h.length > 0).await?;
        self.phase = Phase::Dispatch;
        Ok(&owned.io.scratch[..h.length])
    }
    // Called only after the concrete dispatcher has completed all scopes. A
    // JOB_FINISHED frame alone is not completion: pipes and Child must be joined.
    async fn finish(&mut self, deadline: Instant) -> Result<u32> {
        if self.phase != Phase::Running { return Err("transfer_state"); }
        self.phase = Phase::Failed;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let job = owned.work.job;
        let arena = owned.work.arena;
        owned.io.next(|_| CONTROL, |h| h.exact(9, 4, job, arena, 0)).await?;
        let status = u32::from_be_bytes(owned.io.scratch[..4].try_into().unwrap());
        owned.io.scratch.fill(0);
        if status > 2 { return Err("transfer_status"); }
        if !owned.io.retire_until(deadline).await { return Err("transfer_retirement"); }
        self.phase = Phase::Finished;
        self.owned.take();
        Ok(status)
    }
    pub(super) async fn normalize(
        &mut self,
        capture: &crate::db::source_capture::SourceCapture,
        sealed: &crate::db::source_capture::RawNativeCapture,
        secrets: &[String],
        native_charge:WorkingCharge,
    ) -> Result<()> {
        use crate::db::source_capture::Cursor;
        use serde_json::{json, Value};
        use sha2::{Digest, Sha256};
        use base64::{engine::general_purpose::STANDARD, Engine};
        const ARCHIVE_LIMIT: usize = 8 * 1024 * 1024;
        let hex = |bytes: &[u8]| bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
        let revision = uuid::Uuid::new_v4().to_string();
        let secret_bytes = secrets.iter().map(String::len).sum::<usize>();
        let mut relations = 0usize;
        let mut after = None;
        loop {
            let page = capture.readback_relations(after, 32).await.map_err(|_|"transfer_capture")?;
            let Some(last) = page.last() else { break };
            after = Some((last.from,last.kind,last.position)); relations += page.len();
        }
        self.hello().await?;
        let generation = self.owned.as_ref().ok_or("transfer_closed")?.work.generation;
        self.begin(generation).await?;
        let owned = self.owned.as_mut().ok_or("transfer_closed")?;
        let job = owned.work.job;
        let mut lease = owned.work.arena;
        let mut call = 0u64;
        let mut descriptor = Value::Null;
        // This is the bounded archive result, not a 96 KiB codec control body.
        // Its existing native working charge survives physical E retirement.
        let mut archive = Vec::with_capacity(ARCHIVE_LIMIT);
        loop {
            // Every port reads the same live native capture/policy owner.
            capture.status().await.map_err(|_|"transfer_capture")?;
            let h = owned.io.next(|_|CONTROL, |h|
                h.exact(2,h.length,job,0,0) && h.length > 0
                    || h.exact(9,4,job,owned.work.arena,0)).await?;
            if h.kind == 9 {
                if owned.io.scratch[..4] != 0u32.to_be_bytes() { return Err("transfer_worker_refused"); }
                if descriptor.is_null() || archive.is_empty() { return Err("transfer_archive_missing"); }
                self.normalized=Some((sealed.manifest.clone(),descriptor,archive,native_charge));
                self.phase=Phase::Finished;
                return Ok(());
            }
            let request:Value=serde_json::from_slice(&owned.io.scratch[..h.length]).map_err(|_|"transfer_request")?;
            call=call.checked_add(1).ok_or("transfer_request")?;
            if request["call"].as_str()!=Some(call.to_string().as_str()) { return Err("transfer_request"); }
            let handle=request["handle"].as_str().ok_or("transfer_handle")?;
            let mut outgoing=None;
            let result=match (request["op"].as_u64(),handle) {
                (Some(1),"11") if request["kind"]=="root" => json!({"value":{
                    "kind":"detection","count":secrets.len().to_string(),"bytes":secret_bytes.to_string(),
                    "revision":{"ordinal":0,"bytes":revision.len(),"sha256":hex(&Sha256::digest(revision.as_bytes()))}},"next":null}),
                (Some(1),"11") if request["kind"]=="detection" => {
                    let ordinal=if request["cursor"].is_null(){1}else{decimal(&request["cursor"]["ordinal"])? as usize};
                    let value=secrets.get(ordinal.saturating_sub(1)).map(|text|json!({"ordinal":ordinal,"bytes":text.len(),"sha256":hex(&Sha256::digest(text.as_bytes()))}));
                    json!({"value":value,"next":if ordinal<secrets.len(){json!({"ordinal":(ordinal+1).to_string()})}else{Value::Null}})
                },
                (Some(1),"10") if request["kind"]=="root" => json!({"value":{
                    "kind":"source","manifest":hex(&sealed.manifest),"limits":sealed.limits,
                    "rows":sealed.receipt.rows.to_string(),"fields":sealed.receipt.fields.to_string(),"relations":relations.to_string()},"next":null}),
                (Some(1),"10") if request["kind"]=="field" => {
                    let ordinal=if request["cursor"].is_null(){0}else{decimal(&request["cursor"]["ordinal"])?};
                    let page=capture.readback(Some(Cursor{field:ordinal as i64,offset:0}),1).await.map_err(|_|"transfer_capture")?;
                    let value=page.fragments.first().map(|f|json!({"ordinal":f.field.ordinal,"row":f.field.row,
                        "family":f.field.family,"tag":f.field.tag,"sql_type":f.field.sql_type,"bytes":f.field.bytes,
                        "sha256":hex(f.field.sha256.as_deref().unwrap_or(&[]))}));
                    if page.fragments.first().is_some_and(|f| f.field.bytes>65_536 || f.field.ordinal!=ordinal as i64) {return Err("resource_limit");}
                    json!({"value":value,"next":if ordinal+1<sealed.receipt.fields as u64{json!({"ordinal":(ordinal+1).to_string()})}else{Value::Null}})
                },
                (Some(1),"10") if request["kind"]=="relation" => {
                    let cursor=&request["cursor"];
                    let after=if cursor.is_null(){None}else{
                        let a=decimal(&cursor["from"])? as i64;let b=decimal(&cursor["kind"])? as i64;let c=decimal(&cursor["position"])? as i64;
                        if c>0{Some((a,b,c-1))}else if b>0{Some((a,b-1,i64::MAX))}else if a>0{Some((a-1,i64::MAX,i64::MAX))}else{None}
                    };
                    let page=capture.readback_relations(after,2).await.map_err(|_|"transfer_capture")?;
                    json!({"value":page.first(),"next":page.get(1).map(|r|json!({"from":r.from.to_string(),"kind":r.kind.to_string(),"position":r.position.to_string()}))})
                },
                (Some(2),"10"|"11") => {
                    let ordinal=decimal(&request["ordinal"])?;
                    let offset=decimal(&request["offset"])? as usize;
                    let maximum=decimal(&request["max_bytes"])? as usize;
                    if maximum==0 || maximum>65_536 { return Err("transfer_request"); }
                    let (data,total)=if handle=="11" {
                        let raw=if ordinal==0{revision.as_bytes()}else{secrets.get(ordinal as usize-1).ok_or("transfer_request")?.as_bytes()};
                        if offset>=raw.len(){return Err("transfer_request");}
                        (raw[offset..raw.len().min(offset+maximum)].to_vec(),raw.len())
                    }else{
                        let page=capture.readback(Some(Cursor{field:ordinal as i64,offset:offset as i64}),1).await.map_err(|_|"transfer_capture")?;
                        let f=page.fragments.into_iter().next().ok_or("transfer_request")?;
                        if f.field.ordinal!=ordinal as i64 || f.offset!=offset as i64 || f.data.len()>maximum {return Err("transfer_request");}
                        (f.data,f.field.bytes as usize)
                    };
                    let result=json!({"bytes":data.len().to_string(),"sha256":hex(&Sha256::digest(&data)),
                        "next":if offset+data.len()==total{Value::Null}else{json!((offset+data.len()).to_string())}});
                    outgoing=Some(data); result
                },
                (Some(3),"12") if request["stage"]=="begin" && descriptor.is_null()=>{
                    descriptor=request["descriptor"].clone();append_json_line(&mut archive,&descriptor,ARCHIVE_LIMIT)?;json!({"stage":"begin"})
                },
                (Some(4),"12") if !descriptor.is_null()=>{
                    let bytes=decimal(&request["bytes"])? as usize;
                    if bytes>4093{return Err("resource_limit");}
                    let data=receive_page(&mut owned.io,job,&mut lease,call,bytes).await?;
                    if hex(&Sha256::digest(&data))!=request["sha256"].as_str().ok_or("transfer_request")?{return Err("transfer_integrity");}
                    let offset=decimal(&request["offset"])?;
                    append_json_line(&mut archive,&json!({"header":request["header"],"offset":offset,"data":STANDARD.encode(&data)}),ARCHIVE_LIMIT)?;
                    json!({"kind":"export","ordinal":request["header"]["ordinal"].as_u64().ok_or("transfer_request")?.to_string(),"next_offset":(offset+bytes as u64).to_string()})
                },
                (Some(7),"12") if request["kind"]=="normalized"=>{
                    if request["result"]["manifest"]!=descriptor["manifest_sha256"] {return Err("transfer_integrity");}
                    json!({"kind":"normalized"})
                },
                _=>return Err("transfer_request"),
            };
            let control=grant(&mut owned.io,job,&mut lease,call,1,1).await?;
            let response=serde_json::to_vec(&json!({"op":request["op"],"call":request["call"],"status":0,"result":result})).map_err(|_|"transfer_request")?;
            if response.len()>CONTROL{return Err("resource_limit");}
            owned.io.send(2,job,0,0,&response).await?;
            if let Some(data)=outgoing { send_page(&mut owned.io,job,&mut lease,call,&data).await?; }
            let mut scope=[0u8;12];scope[..8].copy_from_slice(&call.to_be_bytes());
            owned.io.send(6,job,control,0,&scope).await?;
        }
    }
    pub(super) async fn import_archive(&mut self,storage:&crate::db::inactive_storage::InactiveStorage,
        archive:&[u8],descriptor:&serde_json::Value,secrets:&[String],
    )->Result<()> {
        use crate::db::inactive_storage::{Append,RecordHeader};
        use serde_json::{json,Value};
        use sha2::{Digest,Sha256};
        let hex=|bytes:&[u8]|bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
        // This is the archive's consistency label, not target policy authority.
        // Fresh target rights and detection values remain the native storage/
        // transport owner's responsibility on every port call.
        use base64::{engine::general_purpose::STANDARD,Engine};
        let first=archive.split(|b|*b==b'\n').nth(1).ok_or("transfer_metadata")?;
        if first.len()>8192{return Err("resource_limit");}
        let first:Value=serde_json::from_slice(first).map_err(|_|"transfer_metadata")?;
        if first["header"]["ordinal"]!=0 || first["offset"]!=0 || first["header"]["entry"]["purpose"]!="portable_metadata" {return Err("transfer_metadata");}
        let metadata=STANDARD.decode(first["data"].as_str().ok_or("transfer_metadata")?).map_err(|_|"transfer_metadata")?;
        if metadata.len()>4093 || first["header"]["bytes"]!=metadata.len() || first["header"]["sha256"]!=hex(&Sha256::digest(&metadata)) {return Err("transfer_metadata");}
        let metadata:Value=serde_json::from_slice(&metadata).map_err(|_|"transfer_metadata")?;
        let revision=metadata["policy"].as_str().filter(|s|!s.is_empty()&&s.len()<=128).ok_or("transfer_metadata")?.to_owned();
        let secret_bytes=secrets.iter().map(String::len).sum::<usize>();
        if archive.is_empty() || archive.len()>8*1024*1024{return Err("resource_limit");}
        storage.check_native().await.map_err(|_|"transfer_scope")?;
        self.hello().await?;
        let generation=self.owned.as_ref().ok_or("transfer_closed")?.work.generation;
        self.begin(generation).await?;
        let owned=self.owned.as_mut().ok_or("transfer_closed")?;
        let job=owned.work.job;let mut lease=owned.work.arena;let mut call=0u64;
        let mut headers=Vec::<RecordHeader>::new();let mut receipt=None;let mut imported=None;let mut planned=false;
        loop {
            storage.check_native().await.map_err(|_|"transfer_scope")?;
            let h=owned.io.next(|_|CONTROL,|h|h.exact(2,h.length,job,0,0)&&h.length>0 || h.exact(9,4,job,owned.work.arena,0)).await?;
            if h.kind==9 {
                if owned.io.scratch[..4]!=0u32.to_be_bytes(){return Err(match u32::from_be_bytes(owned.io.scratch[..4].try_into().unwrap()){
                    1=>"resource_limit",3=>"transfer_policy_changed",4=>"required_external_context",6=>"preparation_requires_compaction",_=>"import_worker_refused"});}
                self.imported=Some(imported.ok_or("transfer_import_missing")?);self.imported_metadata=Some(metadata);self.phase=Phase::Finished;return Ok(());
            }
            let request:Value=serde_json::from_slice(&owned.io.scratch[..h.length]).map_err(|_|"transfer_request")?;
            call=call.checked_add(1).ok_or("transfer_request")?;
            if request["call"].as_str()!=Some(call.to_string().as_str()){return Err("transfer_request");}
            let handle=request["handle"].as_str().ok_or("transfer_handle")?;let mut outgoing=None;
            let result=match(request["op"].as_u64(),handle) {
                (Some(1),"11") if request["kind"]=="root"=>json!({"value":{
                    "kind":"detection","count":secrets.len().to_string(),"bytes":secret_bytes.to_string(),
                    "revision":{"ordinal":0,"bytes":revision.len(),"sha256":hex(&Sha256::digest(revision.as_bytes()))}},"next":null}),
                (Some(1),"11") if request["kind"]=="detection"=>{
                    let ordinal=if request["cursor"].is_null(){1}else{decimal(&request["cursor"]["ordinal"])? as usize};
                    let value=secrets.get(ordinal.saturating_sub(1)).map(|text|json!({"ordinal":ordinal,"bytes":text.len(),"sha256":hex(&Sha256::digest(text.as_bytes()))}));
                    json!({"value":value,"next":if ordinal<secrets.len(){json!({"ordinal":(ordinal+1).to_string()})}else{Value::Null}})
                },
                (Some(1),"10") if request["kind"]=="root"=>json!({"value":{"kind":"staging","bytes":archive.len().to_string(),
                    "sha256":hex(&Sha256::digest(archive)),"descriptor":descriptor},"next":null}),
                (Some(2),"10"|"11")=>{
                    let ordinal=decimal(&request["ordinal"])? as usize;let offset=decimal(&request["offset"])? as usize;
                    let maximum=decimal(&request["max_bytes"])? as usize;
                    if maximum==0 || maximum>65_536{return Err("resource_limit");}
                    let raw=if handle=="10"{if ordinal!=0{return Err("transfer_request");}archive}
                        else if ordinal==0{revision.as_bytes()}else{secrets.get(ordinal-1).ok_or("transfer_request")?.as_bytes()};
                    if offset>=raw.len(){return Err("transfer_request");}
                    let data=raw[offset..raw.len().min(offset+maximum)].to_vec();
                    let result=json!({"bytes":data.len().to_string(),"sha256":hex(&Sha256::digest(&data)),
                        "next":if offset+data.len()==raw.len(){Value::Null}else{json!((offset+data.len()).to_string())}});
                    outgoing=Some(data);result
                },
                (Some(3),"12") if request["stage"]=="begin" && !planned=>{
                    if request["descriptor"]!=*descriptor{return Err("transfer_integrity");}planned=true;json!({"stage":"begin"})
                },
                (Some(3),"12") if request["stage"]=="header" && planned && receipt.is_none()=>{
                    let header:RecordHeader=serde_json::from_value(request["header"].clone()).map_err(|_|"transfer_header")?;
                    if headers.len()>=4096 || header.ordinal!=headers.len() as u64 || header.bytes>65_536{return Err("resource_limit");}
                    headers.push(header);json!({"stage":"header"})
                },
                (Some(3),"12") if request["stage"]=="end" && planned && receipt.is_none()=>{
                    if request["result"]["manifest"]!=descriptor["manifest_sha256"]{return Err("transfer_integrity");}
                    receipt=Some(storage.begin_portable(descriptor,&headers).await.map_err(|_|"transfer_storage_begin")?);
                    json!({"stage":"end"})
                },
                (Some(4),"12")=>{
                    let receipt=receipt.as_ref().ok_or("transfer_storage_begin")?;
                    let header:RecordHeader=serde_json::from_value(request["header"].clone()).map_err(|_|"transfer_header")?;
                    if headers.get(header.ordinal as usize)!=Some(&header){return Err("transfer_integrity");}
                    let bytes=decimal(&request["bytes"])? as usize;if bytes>4093{return Err("resource_limit");}
                    let data=receive_page(&mut owned.io,job,&mut lease,call,bytes).await?;
                    let append=Append{record:header,offset:decimal(&request["offset"])?,sha256:request["sha256"].as_str().ok_or("transfer_request")?.to_owned()};
                    let control=serde_json::to_vec(&append).map_err(|_|"transfer_request")?;
                    let ack=storage.append(&receipt.key,&control,&data).await.map_err(|_|"transfer_storage_append")?;
                    json!({"kind":"storage","ordinal":ack.ordinal.to_string(),"next_offset":ack.next_offset.to_string(),
                        "received_bytes":ack.received_bytes.to_string(),"revision":ack.revision.to_string()})
                },
                (Some(7),"12") if request["kind"]=="imported" && imported.is_none()=>{
                    let receipt=receipt.as_ref().ok_or("transfer_storage_begin")?;
                    if request["result"]["manifest"]!=descriptor["manifest_sha256"]{return Err("transfer_integrity");}
                    imported=Some(storage.seal_storage(&receipt.key).await.map_err(|_|"transfer_storage_seal")?);
                    json!({"kind":"imported"})
                },
                _=>return Err("transfer_request"),
            };
            let control=grant(&mut owned.io,job,&mut lease,call,1,1).await?;
            let response=serde_json::to_vec(&json!({"op":request["op"],"call":request["call"],"status":0,"result":result})).map_err(|_|"transfer_request")?;
            if response.len()>CONTROL{return Err("resource_limit");}
            owned.io.send(2,job,0,0,&response).await?;
            if let Some(data)=outgoing{send_page(&mut owned.io,job,&mut lease,call,&data).await?;}
            let mut scope=[0u8;12];scope[..8].copy_from_slice(&call.to_be_bytes());owned.io.send(6,job,control,0,&scope).await?;
        }
    }
    pub(super) async fn prepare_archive(&mut self,storage:&crate::db::inactive_storage::InactiveStorage,
        imported:&TransferWorker,secrets:&[String],target:&serde_json::Value,target_fields:&[Vec<u8>],
    )->Result<()> {
        use serde_json::{json,Value};
        use sha2::{Digest,Sha256};
        use crate::db::inactive_storage::Cursor;
        let hex=|bytes:&[u8]|bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
        let completed=imported.imported_storage()?;
        let key=&completed.receipt.key;
        let root=storage.portable_root(key).await.map_err(|_|"transfer_storage_root")?;
        let revision=imported.imported_metadata()?["policy"].as_str().ok_or("transfer_metadata")?.to_owned();
        let secret_bytes=secrets.iter().map(String::len).sum::<usize>();
        self.hello().await?;let generation=self.owned.as_ref().ok_or("transfer_closed")?.work.generation;
        self.begin(generation).await?;
        let owned=self.owned.as_mut().ok_or("transfer_closed")?;
        let job=owned.work.job;let mut lease=owned.work.arena;let mut call=0u64;
        let mut collections=std::collections::BTreeMap::<String,Vec<Value>>::new();
        let mut active:Option<(String,usize)>=None;let mut retained=0usize;let mut finished=false;
        loop {
            storage.check_native().await.map_err(|_|"transfer_scope")?;
            let h=owned.io.next(|_|CONTROL,|h|h.exact(2,h.length,job,0,0)&&h.length>0 || h.exact(9,4,job,owned.work.arena,0)).await?;
            if h.kind==9 {
                if owned.io.scratch[..4]!=0u32.to_be_bytes(){return Err(match u32::from_be_bytes(owned.io.scratch[..4].try_into().unwrap()){
                    1=>"resource_limit",3=>"transfer_policy_changed",4=>"required_external_context",6=>"preparation_requires_compaction",_=>"prepare_worker_refused"});}
                if !finished || active.is_some(){return Err("transfer_preparation_missing");}
                self.prepared_draft=Some(collections);self.phase=Phase::Finished;return Ok(());
            }
            let request:Value=serde_json::from_slice(&owned.io.scratch[..h.length]).map_err(|_|"transfer_request")?;
            call=call.checked_add(1).ok_or("transfer_request")?;
            if request["call"].as_str()!=Some(call.to_string().as_str()){return Err("transfer_request");}
            let handle=request["handle"].as_str().ok_or("transfer_handle")?;let mut outgoing=None;
            let result=match(request["op"].as_u64(),handle) {
                (Some(1),"11") if request["kind"]=="root"=>json!({"value":{
                    "kind":"detection","count":secrets.len().to_string(),"bytes":secret_bytes.to_string(),
                    "revision":{"ordinal":0,"bytes":revision.len(),"sha256":hex(&Sha256::digest(revision.as_bytes()))}},"next":null}),
                (Some(1),"11") if request["kind"]=="detection"=>{
                    let ordinal=if request["cursor"].is_null(){1}else{decimal(&request["cursor"]["ordinal"])? as usize};
                    let value=secrets.get(ordinal.saturating_sub(1)).map(|text|json!({"ordinal":ordinal,"bytes":text.len(),"sha256":hex(&Sha256::digest(text.as_bytes()))}));
                    json!({"value":value,"next":if ordinal<secrets.len(){json!({"ordinal":(ordinal+1).to_string()})}else{Value::Null}})
                },
                (Some(1),"10") if request["kind"]=="root"=>json!({"value":root,"next":null}),
                (Some(1),"13") if request["kind"]=="root"=>json!({"value":target,"next":null}),
                (Some(2),"11"|"13")=>{
                    let ordinal=decimal(&request["ordinal"])? as usize;let offset=decimal(&request["offset"])? as usize;
                    let maximum=decimal(&request["max_bytes"])? as usize;
                    if maximum==0 || maximum>65_536{return Err("resource_limit");}
                    let raw=if handle=="13"{target_fields.get(ordinal).ok_or("transfer_request")?.as_slice()}
                        else if ordinal==0{revision.as_bytes()}else{secrets.get(ordinal-1).ok_or("transfer_request")?.as_bytes()};
                    if offset>=raw.len(){return Err("transfer_request");}
                    let data=raw[offset..raw.len().min(offset+maximum)].to_vec();
                    let result=json!({"bytes":data.len().to_string(),"sha256":hex(&Sha256::digest(&data)),
                        "next":if offset+data.len()==raw.len(){Value::Null}else{json!((offset+data.len()).to_string())}});
                    outgoing=Some(data);result
                },
                (Some(5),"10") if request["limit"]=="1"=>{
                    let from=if request["cursor"].is_null(){(0,0)}else{(decimal(&request["cursor"]["ordinal"])?,decimal(&request["cursor"]["offset"])?) };
                    let after=match from {(0,0)=>None,(ordinal,0)=>Some(Cursor{ordinal:ordinal-1,offset:i64::MAX as u64}),
                        (ordinal,offset)=>Some(Cursor{ordinal,offset:offset-1})};
                    let mut page=storage.readback(key,after,2).await.map_err(|_|"transfer_storage_read")?;
                    if page.fragments.is_empty(){return Err("transfer_storage_read");}
                    let first=page.fragments.remove(0);
                    if (first.record.ordinal,first.offset)!=from{return Err("transfer_storage_cursor");}
                    grant(&mut owned.io,job,&mut lease,call,1,1).await?;
                    let response=serde_json::to_vec(&json!({"op":5,"call":request["call"],"status":0,"result":{
                        "stage":"fragment","record":first.record,"offset":first.offset.to_string(),"bytes":first.bytes.len().to_string(),"targetUuid":first.target_uuid}})).map_err(|_|"transfer_request")?;
                    if response.len()>CONTROL{return Err("resource_limit");}owned.io.send(2,job,0,0,&response).await?;
                    send_page(&mut owned.io,job,&mut lease,call,&first.bytes).await?;
                    json!({"stage":"end","next":page.fragments.first().map(|next|json!({"ordinal":next.record.ordinal.to_string(),"offset":next.offset.to_string()}))})
                },
                (Some(6),"12")=>{
                    let kind=request["kind"].as_str().ok_or("transfer_collection")?;
                    if !["message","citation","image","reference-message","prepared-message","effect-draft","request-metadata"].contains(&kind){return Err("transfer_collection");}
                    let stage=request["stage"].as_str().ok_or("transfer_collection")?;
                    match stage {
                        "begin" if active.is_none()&&!collections.contains_key(kind)=>{
                            let total=decimal(&request["total"])? as usize;if total>4096{return Err("resource_limit");}
                            collections.insert(kind.to_owned(),Vec::with_capacity(total));active=Some((kind.to_owned(),total));
                            json!({"stage":"begin","kind":kind,"total":total.to_string()})
                        },
                        "item"=>{
                            let (name,total)=active.as_ref().ok_or("transfer_collection")?;
                            let values=collections.get_mut(kind).ok_or("transfer_collection")?;
                            if name!=kind || values.len()>=*total || decimal(&request["index"])? as usize!=values.len(){return Err("transfer_collection");}
                            let upper=decimal(&request["upper_json_bytes"])? as usize;if upper>65_536 || upper>8*1024*1024-retained{return Err("resource_limit");}
                            let data=receive_collection(&mut owned.io,job,&mut lease,call,&request,upper).await?;
                            retained+=data.len();values.push(serde_json::from_slice(&data).map_err(|_|"transfer_collection")?);
                            json!({"stage":"item","kind":kind,"index":request["index"]})
                        },
                        "end"=>{
                            let (name,total)=active.take().ok_or("transfer_collection")?;
                            if name!=kind || collections[kind].len()!=total || decimal(&request["total"])? as usize!=total{return Err("transfer_collection");}
                            json!({"stage":"end","kind":kind,"total":total.to_string()})
                        },
                        _=>return Err("transfer_collection"),
                    }
                },
                (Some(7),"12") if request["kind"]=="prepared_ts" && active.is_none()&&!finished=>{
                    let result=&request["result"];
                    if result["draft_handle"]!="12" || result["target_handle"]!="13" || result["archive_manifest"]!=root["binding"]["manifest"]
                        || result["storage_revision"]!=root["storage_revision"] || result["mapping_sha256"]!=root["mapping_sha256"] {return Err("transfer_preparation_binding");}
                    finished=true;json!({"kind":"prepared_ts"})
                },
                _=>return Err("transfer_request"),
            };
            let control=grant(&mut owned.io,job,&mut lease,call,1,1).await?;
            let response=serde_json::to_vec(&json!({"op":request["op"],"call":request["call"],"status":0,"result":result})).map_err(|_|"transfer_request")?;
            if response.len()>CONTROL{return Err("resource_limit");}owned.io.send(2,job,0,0,&response).await?;
            if let Some(data)=outgoing{send_page(&mut owned.io,job,&mut lease,call,&data).await?;}
            let mut scope=[0u8;12];scope[..8].copy_from_slice(&call.to_be_bytes());owned.io.send(6,job,control,0,&scope).await?;
        }
    }
    pub(super) fn complete_native_preparation(&mut self,provider:&crate::db::models::ProviderConfig,
        model:&str,conversation:&str,configuration:Vec<u8>,
    )->Result<()> {
        use serde_json::json;
        if self.phase!=Phase::Finished || self.owned.is_some() || self.native_request.is_some(){return Err("transfer_not_finished");}
        let draft=self.prepared_draft.as_ref().ok_or("transfer_preparation_missing")?;
        let messages=draft.get("prepared-message").ok_or("transfer_preparation_missing")?;
        if !provider.is_enabled || configuration.len()!=32{return Err("provider_unavailable");}
        let request:crate::ai::types::AiChatRequest=serde_json::from_value(json!({"request_id":uuid::Uuid::new_v4(),
            "provider_id":provider.id,"model_id":model,"conversation_id":conversation,"messages":messages}))
            .map_err(|_|"transfer_native_request")?;
        let body=native_body(&request,provider)?;
        if serde_json::to_vec(&body).map_err(|_|"transfer_native_builder")?.len()>8*1024*1024{return Err("resource_limit");}
        self.native_request=Some((request,body,configuration));Ok(())
    }
    pub(crate) fn retarget_native_preparation(&mut self,provider:&crate::db::models::ProviderConfig,conversation:&str,configuration:&[u8])->Result<()> {
        self.native_prepared()?;
        let (previous,body,scope)=self.native_request.as_ref().ok_or("transfer_native_builder_missing")?;
        if configuration!=scope || provider.id!=previous.provider_id || uuid::Uuid::parse_str(conversation).is_err(){return Err("configuration_changed");}
        let mut request=previous.clone();request.conversation_id=Some(conversation.to_owned());
        let rebuilt=native_body(&request,provider)?;
        let mut expected=body.clone();
        if provider.provider_type=="chatgpt" {
            // The real Codex builder binds only its cache key to the allocated
            // conversation. History, instructions and all other fields stay exact.
            if expected["prompt_cache_key"]!=previous.conversation_id.as_deref().unwrap_or_default(){return Err("transfer_native_body_changed");}
            expected["prompt_cache_key"]=serde_json::json!(conversation);
        }
        if rebuilt!=expected{return Err("transfer_native_body_changed");}
        self.native_request=Some((request,rebuilt,scope.clone()));Ok(())
    }
    pub(crate) fn native_prepared(&self)->Result<(&std::collections::BTreeMap<String,Vec<serde_json::Value>>,&crate::ai::types::AiChatRequest,&serde_json::Value,&[u8])>{
        if self.phase!=Phase::Finished || self.owned.is_some(){return Err("transfer_not_finished");}
        let (request,body,configuration)=self.native_request.as_ref().ok_or("transfer_native_builder_missing")?;
        Ok((self.prepared_draft.as_ref().ok_or("transfer_preparation_missing")?,request,body,configuration))
    }
    pub(crate) fn imported_metadata(&self)->Result<&serde_json::Value>{
        self.imported_storage()?;self.imported_metadata.as_ref().ok_or("transfer_metadata")
    }
    pub(crate) fn imported_storage(&self)->Result<&crate::db::inactive_storage::SealedStorage>{
        if self.phase!=Phase::Finished || self.owned.is_some(){return Err("transfer_not_finished");}
        self.imported.as_ref().ok_or("transfer_import_missing")
    }
    pub(crate) fn normalized_for(&self, capture_manifest:&[u8]) -> Result<(&serde_json::Value,&Vec<u8>)> {
        if self.phase!=Phase::Finished || self.owned.is_some(){return Err("transfer_not_finished");}
        let (manifest,descriptor,bytes,_charge)=self.normalized.as_ref().ok_or("transfer_not_normalized")?;
        if manifest!=capture_manifest{return Err("transfer_capture_changed");}
        Ok((descriptor,bytes))
    }
    pub(super) async fn retire_until(&mut self, deadline: Instant) -> bool {
        let finished=self.phase==Phase::Finished;
        self.phase = Phase::Failed;
        if let Some(owned) = self.owned.as_mut() {
            if !owned.io.retire_until(deadline).await { return false; }
        }
        if let Some(owned)=self.owned.take() {
            if finished {self.database=Some(owned.work._database);}
        }
        if finished{self.phase=Phase::Finished;}
        true
    }
}
fn decimal(value:&serde_json::Value)->Result<u64>{
    let s=value.as_str().ok_or("transfer_request")?;
    let n=s.parse::<u64>().map_err(|_|"transfer_request")?;
    if n>MAX_SAFE || n.to_string()!=s { return Err("transfer_request"); } Ok(n)
}
fn append_json_line(out:&mut Vec<u8>,value:&serde_json::Value,maximum:usize)->Result<()> {
    let bytes=serde_json::to_vec(value).map_err(|_|"transfer_request")?;
    if bytes.len()+1>maximum.saturating_sub(out.len()){return Err("resource_limit");}
    out.extend(bytes);out.push(b'\n');Ok(())
}
async fn grant(io:&mut ChildIo,job:u64,lease:&mut u64,call:u64,kind:u8,direction:u8)->Result<u64>{
    *lease=lease.checked_add(1).ok_or("transfer_request")?;
    let mut bytes=[0u8;32];bytes[..8].copy_from_slice(&(if kind==1{1_081_344u64}else{131_072u64}).to_be_bytes());
    bytes[8..16].copy_from_slice(&call.to_be_bytes());bytes[16..24].copy_from_slice(&1u64.to_be_bytes());
    bytes[24..28].copy_from_slice(&(if kind==1{4096u32}else{65_536u32}).to_be_bytes());bytes[28]=kind;bytes[29]=direction;
    io.send(3,job,*lease,0,&bytes).await?;Ok(*lease)
}
async fn send_page(io:&mut ChildIo,job:u64,lease:&mut u64,call:u64,data:&[u8])->Result<()> {
    let id=grant(io,job,lease,call,2,1).await?;
    for (sequence,page) in data.chunks(65_536).enumerate(){
        io.send(4,job,id,sequence as u32,page).await?;
        io.next(|_|CONTROL,|h|h.exact(5,0,job,id,sequence as u32)).await?;
    }Ok(())
}
async fn receive_collection(io:&mut ChildIo,job:u64,lease:&mut u64,call:u64,request:&serde_json::Value,upper:usize)->Result<Vec<u8>> {
    use sha2::{Digest,Sha256};
    let id=grant(io,job,lease,call,2,2).await?;
    let h=io.next(|_|CONTROL,|h|h.exact(2,h.length,job,0,0)&&h.length>0).await?;
    let encoded:serde_json::Value=serde_json::from_slice(&io.scratch[..h.length]).map_err(|_|"transfer_collection")?;
    for key in ["op","call","handle","kind"]{if encoded[key]!=request[key]{return Err("transfer_collection");}}
    let length=decimal(&encoded["bytes"])? as usize;
    if encoded["stage"]!="encoded" || length>upper{return Err("transfer_collection");}
    let mut data=Vec::with_capacity(length);let mut sequence=0;
    while data.len()<length {
        let h=io.next(|_|65_536,|h|h.exact(4,h.length,job,id,sequence)&&h.length>0&&h.length<=length-data.len()).await?;
        data.extend_from_slice(&io.scratch[..h.length]);io.send(5,job,id,sequence,&[]).await?;sequence+=1;
    }
    if encoded["sha256"]!=format!("{:x}",Sha256::digest(&data)){return Err("transfer_collection");}Ok(data)
}
async fn receive_page(io:&mut ChildIo,job:u64,lease:&mut u64,call:u64,length:usize)->Result<Vec<u8>> {
    let id=grant(io,job,lease,call,2,2).await?;
    let mut out=Vec::with_capacity(length);
    let mut sequence=0;
    while out.len()<length {
        let h=io.next(|_|4093,|h|h.exact(4,h.length,job,id,sequence)&&h.length>0&&h.length<=length-out.len()).await?;
        out.extend_from_slice(&io.scratch[..h.length]);io.send(5,job,id,sequence,&[]).await?;sequence+=1;
    }Ok(out)
}
impl Drop for TransferWorker {
    fn drop(&mut self) {
        if let Some(owned) = self.owned.take() {
            if !owned.io.retirement_complete() {
                // Same last-owner closure as runtime quarantine. Never detach a
                // Busy Windows pipe or refund a still-live Child's reservation.
                std::mem::forget(owned);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connect_resources::{TransitOwner, TRANSIT_INSTANCE_LIMIT};
    use std::time::Duration;

    // This is a real worker protocol refusal, not a successful fake DB port.
    // No archive, draft, policy authority or provider result is manufactured.
    #[tokio::test]
    async fn real_e_worker_refusal_finishes_once_and_retires_all_pipes() {
        let budget = TransitOwner::default().instance(uuid::Uuid::new_v4()).unwrap();
        // The worker retains a second control reservation before requesting
        // its policy root. Fund that real refusal path and the parent IO.
        let charge = budget.reserve(4 * 1024 * 1024).unwrap();
        let mut command = Command::new(super::super::runtime::test_bun());
        command.arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../copilot-bridge/src/entry.ts")).arg("connect-transfer");
        let mut io = ChildIo::spawn(command).unwrap();
        let exchange = async {
            let h = io.next(|_| CONTROL, |h| h.exact(1, h.length, 0, 0, 0)).await?;
            let hello: Hello = serde_json::from_slice(&io.scratch[..h.length]).map_err(|_| "hello")?;
            if hello.version != "macro-connect-transfer-1" { return Err("hello_version"); }
            let start = br#"{"op":0,"kind":"normalize","handles":{"source":"1","policy":"2","sink":"3"},"child_units":"2293760","detection_units":"1024","native_units":"1212416"}"#;
            io.send(2, 1, 0, 0, start).await?;
            let mut grant = [0u8; 32];
            grant[..8].copy_from_slice(&2_294_784u64.to_be_bytes());
            grant[16..24].copy_from_slice(&1u64.to_be_bytes());
            grant[28] = 3;
            io.send(3, 1, 1, 0, &grant).await?;
            let h = io.next(|_| CONTROL, |h| h.exact(2, h.length, 1, 0, 0)).await?;
            let request: serde_json::Value = serde_json::from_slice(&io.scratch[..h.length]).map_err(|_| "request")?;
            if request["op"] != 1 || request["kind"] != "root"
                || request["handle"] != "2" || request["call"] != "1"
            { return Err("detection_request"); }
            // Explicit unavailable response. No permission or successful effect.
            grant[..8].copy_from_slice(&1_081_344u64.to_be_bytes());
            grant[8..16].copy_from_slice(&1u64.to_be_bytes());
            grant[24..28].copy_from_slice(&4096u32.to_be_bytes());
            grant[28] = 1;
            grant[29] = 1;
            io.send(3, 1, 2, 0, &grant).await?;
            io.send(2, 1, 0, 0, br#"{"op":1,"call":"1","status":5}"#).await?;
            let mut scope = [0u8; 12];
            scope[..8].copy_from_slice(&1u64.to_be_bytes());
            scope[8..].copy_from_slice(&5u32.to_be_bytes());
            io.send(6, 1, 2, 0, &scope).await?;
            io.next(|_| CONTROL, |h| h.exact(9, 4, 1, 1, 0)).await?;
            if io.scratch[..4] != 1u32.to_be_bytes() { return Err("finished_status"); }
            Ok::<_, &'static str>(())
        };
        let result = tokio::time::timeout(Duration::from_secs(10), exchange).await;
        let retired = io.retire_until(Instant::now() + Duration::from_secs(10)).await;
        if !retired {
            // Preserve both IO and its charge even when reporting fixture failure.
            std::mem::forget((io, charge));
            panic!("worker retirement not demonstrated");
        }
        assert!(budget.reserve(TRANSIT_INSTANCE_LIMIT).is_err());
        drop(io);
        drop(charge);
        drop(budget.reserve(TRANSIT_INSTANCE_LIMIT).unwrap());
        assert_eq!(result, Ok(Ok(())));
    }
}

fn native_body(request:&crate::ai::types::AiChatRequest,provider:&crate::db::models::ProviderConfig)->Result<serde_json::Value>{
    if !provider.is_enabled || request.provider_id!=provider.id{return Err("provider_unavailable");}
    match provider.provider_type.as_str() {
        "chatgpt"=>serde_json::to_value(crate::ai::chatgpt::build_transfer_request(request).map_err(|_|"transfer_native_builder")?).map_err(|_|"transfer_native_builder"),
        "openai" if provider.id=="macro-ai"=>crate::ai::openai_compatible::build_transfer_request(request,provider).map_err(|_|"transfer_native_builder"),
        _=>Err("provider_unavailable"),
    }
}
