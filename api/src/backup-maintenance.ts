import {pool,fail} from './core.js';
import {backupEnabled,deleteObject} from './storage.js';

// S3 and PostgreSQL cannot commit atomically. Mark a row as deleting before
// removing its object. On a transport error the row remains for a later retry;
// after S3 succeeds, deleting the row is safe to retry (S3 DELETE is idempotent).
async function removeBackup(id:string,automatic:boolean):Promise<boolean>{
 if(!backupEnabled())return false;
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const b=(await c.query('SELECT id,server_id,object_key,state FROM backups WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!b){await c.query('COMMIT');return false;}
  if(!['succeeded','failed','deleting'].includes(b.state)){
   if(!automatic)fail(409,'Backup is still in progress');
   await c.query('COMMIT');return false;
  }
  const policy=(await c.query('SELECT backup_retention_days FROM servers WHERE id=$1',[b.server_id])).rows[0];
  if(automatic&&b.state!=='deleting'&&(!policy?.backup_retention_days||!(await c.query("SELECT 1 FROM backups WHERE id=$1 AND created_at<now()-($2::int * interval '1 day')",[id,policy.backup_retention_days])).rowCount)){
   await c.query('COMMIT');return false;
  }
  if(b.state==='succeeded'){
   const newest=(await c.query("SELECT id FROM backups WHERE server_id=$1 AND state='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1",[b.server_id])).rows[0];
   if(newest?.id===id){if(!automatic)fail(409,'Cannot delete the latest successful backup');await c.query('COMMIT');return false;}
  }
  // Restore jobs can target a different server, so match their source backup
  // rather than filtering by this backup's server_id.
  const active=await c.query("SELECT 1 FROM jobs WHERE kind IN ('restore','verify-backup') AND payload->>'backupId'=$1 AND state IN ('queued','running') LIMIT 1",[id]);
  if(active.rowCount){if(!automatic)fail(409,'Backup is in use by a restore job');await c.query('COMMIT');return false;}
  if(b.state!=='deleting')await c.query("UPDATE backups SET state='deleting' WHERE id=$1",[id]);
  await c.query('COMMIT');
  // Do not hold a DB transaction open across a potentially slow S3 request.
  await deleteObject(b.object_key);
  await pool.query("DELETE FROM backups WHERE id=$1 AND state='deleting'",[id]);
  return true;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function deleteBackup(id:string){return removeBackup(id,false);}
export async function sweepBackupRetention(){
 if(!backupEnabled())return;
 // The sweeper is single-process today. A row marked deleting is retried after
 // any S3/DB error. The conditional update below prevents concurrent workers
 // from claiming the same row, and an advisory lock serializes sweeps.
 const lock=await pool.connect();
 try{
  const held=(await lock.query('SELECT pg_try_advisory_lock(711201, 4) AS locked')).rows[0].locked;
  if(!held)return;
  try{
   const rows=(await lock.query(`SELECT b.id FROM backups b JOIN servers s ON s.id=b.server_id
    WHERE (b.state='deleting' OR (s.backup_retention_days>0
      AND b.state IN ('succeeded','failed')
      AND b.created_at<now()-(s.backup_retention_days * interval '1 day')
      AND (b.state<>'succeeded' OR b.id<>(SELECT latest.id FROM backups latest WHERE latest.server_id=b.server_id AND latest.state='succeeded' ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1))))
    ORDER BY b.created_at,b.id LIMIT 20`)).rows;
   for(const row of rows){try{await removeBackup(row.id,true);}catch(e){console.error('Backup retention deletion failed; will retry',row.id,e);}}
  }finally{await lock.query('SELECT pg_advisory_unlock(711201, 4)');}
 }finally{lock.release();}
}
