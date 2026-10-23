export interface PortableSource { ordinal:number; row:number; family:number; tag:number; sqlType:0|1|2|3; path?:(string|number)[] }
export interface PortableOrigin { version:1; normalizer:'macro-portable-history-1'; policy:string; source:PortableSource; classification:'retained_original'|'redundant_representation'|'excluded_local_metadata'; reason:string; meaning?:'original'|'message'|'data'|'reflection'|'citation'|'asset'|'checkpoint'; message?:string; timestamp?:string; sourceHash?:string; sourceBytes?:number; captureManifest?:string; retained?:number; sourceLimits?:readonly string[]; remainingLimits?:readonly string[] }
export type PortableEntry = {kind:'message';role:'user'|'assistant'} | {kind:'historical_text';purpose:'portable_metadata'|'original_text'|'historical_data'} | {kind:'citation'} | {kind:'asset';mime:'text_plain'|'image_png'|'image_jpeg'|'image_webp'} | {kind:'association';from:number;to:number;position:number;relation:'asset_for_message'|'citation_for_message'|'data_for_message'};
export interface PortableHeader {ordinal:number;entry:PortableEntry;bytes:number;sha256:string;origin?:number}
export interface PortableDescriptor {kind:'portable_archive';format:'portable-chat-history-1';content_contract_sha256:string;records:number;bytes:number;manifest_sha256:string}
export const vocabulary: {format:string;profile:string;normalizer:string;families:{table:string;columns:string[];integers:string[];nullable:string[]}[];classifications:string[];meanings:string[];reasons:Record<string,string[]>;sourceLimits:string[];remainingLimits:string[];providerKeys:Record<string,string[]>;mime:Record<string,string>};
export const FRAGMENT_BYTES:4093;
export const FRAME_BYTES:8192;
export function assertPortableUnicode(value:unknown):void;
export function validatePortableHeader(value:unknown):PortableHeader;
export function renderPortableHeader(value:PortableHeader):string;
export function validatePortableMetadata(value:unknown):PortableOrigin;
export function portableManifestInput(capture:string,policy:string,headers:PortableHeader[]):Uint8Array;
export function validatePortableDescriptor(value:unknown,contractSha:string):PortableDescriptor;
export function decodePortableFrame(raw:string):unknown;
export function portableLines(chunks:AsyncIterable<Uint8Array>):AsyncGenerator<string>;
export interface PortableValidationPorts {reserve(bytes:number):()=>void;digest(bytes:Uint8Array):Promise<string>;inspect(header:PortableHeader,bytes:Uint8Array,origin:PortableOrigin|undefined,metadata:PortableOrigin|undefined):Promise<void>;append(header:PortableHeader,bytes:Uint8Array):Promise<void>}
export function validatePortableArchive(lines:AsyncIterable<string>,contractSha:string,ports:PortableValidationPorts):Promise<{records:number;fragments:number;bytes:number;manifest:string}>;
