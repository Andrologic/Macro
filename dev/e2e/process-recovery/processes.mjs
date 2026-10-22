// Linux-only supervision for fixtures whose descendants keep a private cwd.
// This is not containment for arbitrary commands that change cwd and session.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

function processTable() {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000 });
  assert.equal(result.status, 0, `Cannot inspect fixture processes: ${result.stderr}`);
  return result.stdout.split('\n').map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length === 4).map(([pid, parent, group, state]) => ({
      pid: Number(pid), parent: Number(parent), group: Number(group), state,
    }));
}

export function ownedGroups(roots, directory, deadline = Date.now() + 5000) {
  const rows = processTable();
  const privateRoot = realpathSync(directory);
  const owned = new Set(roots);
  for (const row of rows) {
    assert(Date.now() < deadline, 'Fixture process inventory exceeded its deadline');
    // Read only cwd links, never environments or file contents of other processes.
    let cwd;
    try { cwd = readlinkSync(`/proc/${row.pid}/cwd`); }
    catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) continue;
      throw error;
    }
    if (cwd === privateRoot || cwd.startsWith(`${privateRoot}${path.sep}`)) owned.add(row.pid);
  }
  let changed;
  do {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
  } while (changed);
  return [...new Set([...roots, ...rows.filter(row => owned.has(row.pid) && !row.state.startsWith('Z')).map(row => row.group)])];
}

export function runningInGroups(groups) {
  return processTable().filter(row => groups.includes(row.group) && !row.state.startsWith('Z'));
}

function signal(id, name) {
  try { process.kill(id, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function stopProcesses(roots, exits, directory, inspect = ownedGroups) {
  const deadline = Date.now() + 5000;
  const groups = new Set(roots);
  let inventoryError;
  try {
    for (const pid of roots) signal(pid, 'SIGSTOP');
    for (const group of inspect(roots, directory, deadline)) groups.add(group);
  } catch (error) { inventoryError = error; }
  finally {
    // Known roots must still be killed when ps or cwd inspection fails.
    for (const group of groups) signal(-group, 'SIGKILL');
  }
  let timer;
  const statuses = await Promise.race([
    Promise.all(exits),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture process termination exceeded 5 seconds')), Math.max(1, deadline - Date.now())); }),
  ]).finally(() => clearTimeout(timer));
  if (inventoryError) throw inventoryError;
  // Re-adopted descendants can outlive their root and have another PGID/session.
  // Their inherited private cwd remains our identity after that root has exited.
  while (true) {
    for (const group of inspect([], directory, deadline)) groups.add(group);
    const live = runningInGroups([...groups]);
    if (live.length === 0) return { groups: [...groups], statuses };
    for (const group of new Set(live.map(row => row.group))) signal(-group, 'SIGKILL');
    assert(Date.now() < deadline, 'Fixture descendants did not stop within 5 seconds');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
