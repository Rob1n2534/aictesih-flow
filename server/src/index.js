require('dotenv').config();
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://aictesih:demo_password_change_me@localhost:5433/aictesih' });
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(cors({ origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 80 }));

const ROLES = ['institution', 'regional_officer', 'bureau_officer', 'committee', 'admin'];
const STAGES = ['Submitted', 'Regional Scrutiny', 'Bureau Review', 'EVC / Inspection', 'Committee Review', 'Decision'];
const REQUIRED_DOCS = ['Application Form', 'Institution Registration', 'Land / Lease Document', 'Faculty Details', 'Infrastructure Details', 'Undertaking'];
const OPTIONAL_DOCS = ['Compliance Evidence / EVC Note'];
const ALLOWED_DOCS = new Set([...REQUIRED_DOCS, ...OPTIONAL_DOCS]);
const VALID_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);
const MAX_BYTES = 10 * 1024 * 1024;

async function query(sql, params = []) { return pool.query(sql, params); }
async function initDb() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('institution','regional_officer','bureau_officer','committee','admin')),
    institution_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS applications (
    id SERIAL PRIMARY KEY, reference_no TEXT UNIQUE NOT NULL, institution_name TEXT NOT NULL,
    applicant_id INTEGER NOT NULL REFERENCES users(id), application_type TEXT NOT NULL DEFAULT 'Approval / Extension',
    stage TEXT NOT NULL DEFAULT 'Submitted', status TEXT NOT NULL DEFAULT 'Under Review',
    notes TEXT DEFAULT '', due_date DATE, compliance_due DATE, lease_expiry DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL, sha256 TEXT NOT NULL, expiry_date DATE, ocr_text TEXT DEFAULT '', uploaded_by INTEGER REFERENCES users(id), uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY, application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
    recipient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL,
    message TEXT NOT NULL, due_at DATE, is_read BOOLEAN NOT NULL DEFAULT FALSE, dedupe_key TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS evc_visits (
    id SERIAL PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMPTZ NOT NULL, assigned_to TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Scheduled',
    notes TEXT DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY, actor_id INTEGER REFERENCES users(id), actor_name TEXT NOT NULL, actor_role TEXT NOT NULL,
    application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL, action TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS workflow_rules (
    id SERIAL PRIMARY KEY, rule_key TEXT NOT NULL, version INTEGER NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb, approved_by TEXT NOT NULL DEFAULT 'Demo administrator', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(rule_key,version))`);
  const count = await query('SELECT COUNT(*)::int AS n FROM users');
  if (count.rows[0].n === 0) {
    const seed = [
      ['Demo Institution User','institution@demo.in','Demo@123','institution','Sunrise Institute of Technology'],
      ['Regional Officer','regional@demo.in','Demo@123','regional_officer',null],
      ['Bureau Officer','bureau@demo.in','Demo@123','bureau_officer',null],
      ['Committee Member','committee@demo.in','Demo@123','committee',null],
      ['System Administrator','admin@demo.in','Demo@123','admin',null]
    ];
    for (const [name,email,password,role,institution] of seed) {
      await query('INSERT INTO users(name,email,password_hash,role,institution_name) VALUES($1,$2,$3,$4,$5)', [name,email,await bcrypt.hash(password,10),role,institution]);
    }
    const u = await query("SELECT id FROM users WHERE email='institution@demo.in'");
    const aid = await query(`INSERT INTO applications(reference_no,institution_name,applicant_id,stage,status,due_date,compliance_due,lease_expiry)
      VALUES('AICTE-DEMO-2026-001','Sunrise Institute of Technology',$1,'Regional Scrutiny','Under Review',CURRENT_DATE + 7,CURRENT_DATE + 14,CURRENT_DATE + 45) RETURNING id`, [u.rows[0].id]);
    await query("INSERT INTO alerts(application_id,recipient_user_id,kind,title,message,due_at,dedupe_key) VALUES($1,$2,'workflow','Application under regional scrutiny','Your application has moved to Regional Scrutiny.',CURRENT_DATE + 7,'seed-workflow-alert')", [aid.rows[0].id,u.rows[0].id]);
    await query("INSERT INTO workflow_rules(rule_key,version,enabled,config,approved_by) VALUES ('required-documents',1,true,$1,'Demo administrator'),('expiry-reminders',1,true,$2,'Demo administrator')", [JSON.stringify({required:REQUIRED_DOCS, maxFileSizeMB:10}),JSON.stringify({remindDays:[30,14,7,1]})]);
    await query("INSERT INTO audit_logs(actor_id,actor_name,actor_role,application_id,action,details) VALUES($1,'System Setup','admin',$2,'DEMO_SEED_CREATED',$3)", [u.rows[0].id,aid.rows[0].id,JSON.stringify({note:'Synthetic demo record; not an official AICTE record'})]);
  }
}

function auth(req,res,next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || 'local_demo_secret_change_before_deployment'); next(); }
  catch { return res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
}
function allow(...roles) { return (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({error:'Your role does not have permission for this action.'}); }
async function audit(req, applicationId, action, details = {}) {
  await query('INSERT INTO audit_logs(actor_id,actor_name,actor_role,application_id,action,details) VALUES($1,$2,$3,$4,$5,$6)', [req.user.id,req.user.name,req.user.role,applicationId,action,JSON.stringify(details)]);
}
async function notify(userId, applicationId, kind, title, message, dueAt = null, dedupeKey = null) {
  const inserted = await query(`INSERT INTO alerts(application_id,recipient_user_id,kind,title,message,due_at,dedupe_key)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [applicationId,userId,kind,title,message,dueAt,dedupeKey]);
  // Optional SMTP delivery. In-app alerts remain the default and work without email credentials.
  if (inserted.rowCount && process.env.ENABLE_EMAIL === 'true' && process.env.SMTP_HOST) {
    try {
      const nodemailer = require('nodemailer');
      const recipient = await query('SELECT email FROM users WHERE id=$1',[userId]);
      if (recipient.rows[0]?.email) {
        const transport = nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:Number(process.env.SMTP_PORT||587)===465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined});
        await transport.sendMail({from:process.env.EMAIL_FROM||'AICTE FLOW Demo <no-reply@example.test>',to:recipient.rows[0].email,subject:`[AICTE FLOW Demo] ${title}`,text:`${message}${dueAt?`\nDue date: ${dueAt}`:''}\n\nThis is a synthetic SIH 2026 prototype notification, not an official AICTE communication.`});
      }
    } catch (e) { console.error('Optional email delivery failed:',e.message); }
  }
}
async function getApplication(id) { const r = await query('SELECT * FROM applications WHERE id=$1',[id]); return r.rows[0]; }
async function canSeeApplication(req, appId) {
  const a = await getApplication(appId); if (!a) return { error: 'Application not found.' };
  if (req.user.role === 'institution' && a.applicant_id !== req.user.id) return { error: 'Application not found.' };
  return { application: a };
}
function dateOnly(value) { if (!value) return null; const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10); }

app.get('/api/health', (_req,res) => res.json({ ok:true, service:'AICTE SIH workflow prototype', demo:true }));
app.post('/api/auth/login', async (req,res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({error:'Email and password are required.'});
  const r = await query('SELECT * FROM users WHERE lower(email)=lower($1)',[email]); const user = r.rows[0];
  if (!user || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({error:'Invalid email or password.'});
  const token = jwt.sign({id:user.id,name:user.name,email:user.email,role:user.role,institution_name:user.institution_name}, process.env.JWT_SECRET || 'local_demo_secret_change_before_deployment', {expiresIn:'8h'});
  await query('INSERT INTO audit_logs(actor_id,actor_name,actor_role,action,details) VALUES($1,$2,$3,$4,$5)',[user.id,user.name,user.role,'LOGIN',{email:user.email}]);
  res.json({token,user:{id:user.id,name:user.name,email:user.email,role:user.role,institution_name:user.institution_name}});
});
app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));

app.get('/api/dashboard',auth,async(req,res)=>{
  // Role-focused work queues; the Applications screen remains available to authorised staff for broader case lookup.
  let filter = ''; let params = [];
  if (req.user.role==='institution') { filter='WHERE applicant_id=$1'; params=[req.user.id]; }
  else if (req.user.role==='regional_officer') filter="WHERE stage='Regional Scrutiny' OR status='Returned for Correction'";
  else if (req.user.role==='bureau_officer') filter="WHERE stage='Bureau Review' OR status='Returned for Correction'";
  else if (req.user.role==='committee') filter="WHERE stage IN ('EVC / Inspection','Committee Review') OR status='Returned for Correction'";
  const apps = await query(`SELECT a.*, (SELECT COUNT(*)::int FROM documents d WHERE d.application_id=a.id) document_count,
    (SELECT COUNT(*)::int FROM alerts al WHERE al.application_id=a.id AND al.kind IN ('deadline','expiry') AND al.is_read=false) open_alerts
    FROM applications a ${filter} ORDER BY a.updated_at DESC`,params);
  const counts = { total:apps.rows.length, pending:apps.rows.filter(a=>!['Approved','Rejected'].includes(a.status)).length,
    returned:apps.rows.filter(a=>a.status==='Returned for Correction').length, overdue:apps.rows.filter(a=>a.due_date && new Date(a.due_date)<new Date() && !['Approved','Rejected'].includes(a.status)).length,
    evc:apps.rows.filter(a=>a.stage==='EVC / Inspection').length };
  const alertParams = req.user.role==='institution' ? [req.user.id] : [];
  const alertFilter = req.user.role==='institution' ? 'WHERE recipient_user_id=$1' : '';
  const alerts = await query(`SELECT al.*,a.reference_no FROM alerts al LEFT JOIN applications a ON a.id=al.application_id ${alertFilter} ORDER BY al.created_at DESC LIMIT 8`,alertParams);
  res.json({applications:apps.rows,counts,alerts:alerts.rows,stages:STAGES});
});
app.get('/api/applications',auth,async(req,res)=>{
  const r = req.user.role==='institution' ? await query('SELECT * FROM applications WHERE applicant_id=$1 ORDER BY created_at DESC',[req.user.id]) : await query('SELECT * FROM applications ORDER BY created_at DESC');
  res.json({applications:r.rows});
});
app.post('/api/applications',auth,allow('institution','admin'),async(req,res)=>{
  const institutionName = String(req.body.institution_name || req.user.institution_name || '').trim();
  const applicationType = String(req.body.application_type || 'Approval / Extension').trim();
  const dueDate = dateOnly(req.body.due_date);
  if (!institutionName) return res.status(400).json({error:'Institution name is required.'});
  const ref = 'DEMO-' + new Date().getFullYear() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const r = await query(`INSERT INTO applications(reference_no,institution_name,applicant_id,application_type,due_date,compliance_due,lease_expiry)
    VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING *`,[ref,institutionName,req.user.id,applicationType,dueDate,dateOnly(req.body.lease_expiry)]);
  await audit(req,r.rows[0].id,'APPLICATION_CREATED',{reference_no:ref,application_type:applicationType});
  await notify(req.user.id,r.rows[0].id,'workflow','Application created',`Application ${ref} was created and is ready for document upload.`,dueDate,`application-created-${r.rows[0].id}`);
  res.status(201).json({application:r.rows[0],required_documents:REQUIRED_DOCS});
});
app.get('/api/applications/:id',auth,async(req,res)=>{
  const found=await canSeeApplication(req,Number(req.params.id)); if(found.error) return res.status(404).json({error:found.error});
  const [docs,visits,logs,rule] = await Promise.all([
    query('SELECT id,doc_type,original_name,mime_type,size_bytes,sha256,expiry_date,ocr_text,uploaded_at FROM documents WHERE application_id=$1 ORDER BY uploaded_at DESC',[req.params.id]),
    query('SELECT * FROM evc_visits WHERE application_id=$1 ORDER BY scheduled_at DESC',[req.params.id]),
    query('SELECT actor_name,actor_role,action,details,created_at FROM audit_logs WHERE application_id=$1 ORDER BY created_at DESC LIMIT 50',[req.params.id]),
    query('SELECT rule_key,version,enabled,config,approved_by,created_at FROM workflow_rules ORDER BY rule_key,version DESC')
  ]);
  const uploaded = new Set(docs.rows.map(d=>d.doc_type));
  res.json({application:found.application,documents:docs.rows,required_documents:REQUIRED_DOCS,missing_documents:REQUIRED_DOCS.filter(d=>!uploaded.has(d)),visits:visits.rows,audit:logs.rows,rules:rule.rows});
});
const storage = multer.diskStorage({ destination:(_req,_file,cb)=>cb(null,UPLOAD_DIR), filename:(_req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).slice(0,12)) });
const upload = multer({storage,limits:{fileSize:MAX_BYTES,files:10},fileFilter:(_req,file,cb)=>VALID_TYPES.has(file.mimetype)?cb(null,true):cb(new Error('Unsupported file type. Use PDF, PNG, JPG or TXT.'))});
app.post('/api/applications/:id/documents',auth,upload.single('file'),async(req,res)=>{
  try {
    const found=await canSeeApplication(req,Number(req.params.id)); if(found.error) { if(req.file) fs.unlinkSync(req.file.path); return res.status(404).json({error:found.error}); }
    if (!['institution','admin'].includes(req.user.role) && req.user.role!=='regional_officer') { if(req.file) fs.unlinkSync(req.file.path); return res.status(403).json({error:'Your role cannot upload institution documents.'}); }
    if (!req.file) return res.status(400).json({error:'Choose a file first.'});
    const docType=String(req.body.doc_type||'').trim(); if(!ALLOWED_DOCS.has(docType)) { fs.unlinkSync(req.file.path); return res.status(400).json({error:'Choose a document type from the document-type list.'}); }
    const bytes=fs.readFileSync(req.file.path); const sha=crypto.createHash('sha256').update(bytes).digest('hex');
    let ocrText='';
    if(process.env.ENABLE_OCR==='true' && req.file.mimetype.startsWith('image/')) {
      try { const Tesseract=require('tesseract.js'); const result=await Tesseract.recognize(req.file.path,'eng'); ocrText=(result.data.text||'').slice(0,5000); }
      catch(e) { ocrText='OCR unavailable for this file; please verify manually.'; }
    }
    const r=await query(`INSERT INTO documents(application_id,doc_type,original_name,stored_name,mime_type,size_bytes,sha256,expiry_date,ocr_text,uploaded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,doc_type,original_name,mime_type,size_bytes,sha256,expiry_date,ocr_text,uploaded_at`,
      [req.params.id,docType,req.file.originalname,req.file.filename,req.file.mimetype,req.file.size,sha,dateOnly(req.body.expiry_date),ocrText,req.user.id]);
    await query('UPDATE applications SET updated_at=NOW() WHERE id=$1',[req.params.id]);
    await audit(req,Number(req.params.id),'DOCUMENT_UPLOADED',{doc_type:docType,file_name:req.file.originalname,sha256:sha,expiry_date:dateOnly(req.body.expiry_date)});
    res.status(201).json({document:r.rows[0],checks:{type:'passed',size:'passed',sha256:sha,ocr:ocrText?'text extracted':'not run (optional)'}});
  } catch(e) { if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); throw e; }
});
app.post('/api/applications/:id/submit',auth,allow('institution','admin'),async(req,res)=>{
  const found=await canSeeApplication(req,Number(req.params.id)); if(found.error) return res.status(404).json({error:found.error});
  const docs=await query('SELECT DISTINCT doc_type FROM documents WHERE application_id=$1',[req.params.id]);
  const have=new Set(docs.rows.map(d=>d.doc_type)); const missing=REQUIRED_DOCS.filter(d=>!have.has(d));
  if(missing.length) return res.status(400).json({error:'Submission blocked: required documents are missing.',missing_documents:missing,reason:`Upload these required items: ${missing.join(', ')}.`});
  await query("UPDATE applications SET stage='Regional Scrutiny',status='Under Review',updated_at=NOW() WHERE id=$1",[req.params.id]);
  await audit(req,Number(req.params.id),'APPLICATION_SUBMITTED',{checked_required_documents:REQUIRED_DOCS.length,rule_version:1});
  const officers=await query("SELECT id FROM users WHERE role='regional_officer'"); for(const o of officers.rows) await notify(o.id,Number(req.params.id),'workflow','New application for scrutiny',`${found.application.reference_no} is ready for Regional Scrutiny.`,found.application.due_date,`new-scrutiny-${req.params.id}-${o.id}`);
  await notify(found.application.applicant_id,Number(req.params.id),'workflow','Application submitted','Document checklist passed. Your application is in Regional Scrutiny.',found.application.due_date,`submitted-${req.params.id}`);
  res.json({ok:true,message:'Checklist passed. Application moved to Regional Scrutiny.'});
});
app.post('/api/applications/:id/workflow',auth,allow('regional_officer','bureau_officer','committee','admin'),async(req,res)=>{
  const found=await canSeeApplication(req,Number(req.params.id)); if(found.error) return res.status(404).json({error:found.error});
  const {action,reason='',next_stage,decision=''}=req.body||{};
  let stage=found.application.stage,status=found.application.status;
  if(action==='return') { if(String(reason).trim().length<5) return res.status(400).json({error:'A clear return reason (at least 5 characters) is required.'}); status='Returned for Correction'; }
  else if(action==='forward') { const index=STAGES.indexOf(stage); stage=next_stage && STAGES.includes(next_stage) ? next_stage : STAGES[Math.min(index+1,STAGES.length-1)]; status='Under Review'; }
  else if(action==='decision') { if(!['Approved','Rejected'].includes(decision)) return res.status(400).json({error:'Select Approved or Rejected.'}); stage='Decision'; status=decision; }
  else return res.status(400).json({error:'Action must be forward, return, or decision.'});
  await query('UPDATE applications SET stage=$1,status=$2,notes=$3,updated_at=NOW() WHERE id=$4',[stage,status,String(reason||decision||''),req.params.id]);
  await audit(req,Number(req.params.id),action==='decision'?'DECISION_RECORDED':action==='return'?'APPLICATION_RETURNED':'WORKFLOW_STAGE_CHANGED',{from_stage:found.application.stage,to_stage:stage,status,reason,decision});
  const title=action==='return'?'Correction required':action==='decision'?'Application decision recorded':'Application stage updated';
  const message=action==='return'?`Application returned for correction: ${reason}`:action==='decision'?`Application decision: ${decision}. ${reason}`:`Application moved to ${stage}. ${reason}`;
  await notify(found.application.applicant_id,Number(req.params.id),'workflow',title,message,found.application.due_date,`workflow-${req.params.id}-${Date.now()}`);
  res.json({ok:true,application:await getApplication(req.params.id)});
});
app.post('/api/applications/:id/evc',auth,allow('regional_officer','bureau_officer','committee','admin'),async(req,res)=>{
  const found=await canSeeApplication(req,Number(req.params.id)); if(found.error) return res.status(404).json({error:found.error});
  const scheduled=new Date(req.body.scheduled_at); if(!req.body.scheduled_at||Number.isNaN(scheduled.getTime())) return res.status(400).json({error:'Choose a valid EVC date and time.'});
  const assigned=String(req.body.assigned_to||'').trim(); if(!assigned) return res.status(400).json({error:'Assignee is required.'});
  const r=await query('INSERT INTO evc_visits(application_id,scheduled_at,assigned_to,notes,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.params.id,scheduled.toISOString(),assigned,String(req.body.notes||''),req.user.id]);
  await query("UPDATE applications SET stage='EVC / Inspection',updated_at=NOW() WHERE id=$1",[req.params.id]);
  await audit(req,Number(req.params.id),'EVC_SCHEDULED',{scheduled_at:scheduled.toISOString(),assigned_to:assigned});
  await notify(found.application.applicant_id,Number(req.params.id),'evc','EVC / inspection scheduled',`Visit scheduled for ${scheduled.toLocaleString()} with ${assigned}.`,dateOnly(scheduled),`evc-${r.rows[0].id}`);
  res.status(201).json({visit:r.rows[0]});
});
app.patch('/api/evc/:id',auth,allow('regional_officer','bureau_officer','committee','admin'),async(req,res)=>{
  const id=Number(req.params.id); const status=String(req.body.status||''); if(!['Scheduled','Completed','Rescheduled','Cancelled'].includes(status)) return res.status(400).json({error:'Invalid EVC status.'});
  const old=await query('SELECT * FROM evc_visits WHERE id=$1',[id]); if(!old.rows[0]) return res.status(404).json({error:'EVC visit not found.'});
  const r=await query('UPDATE evc_visits SET status=$1,notes=$2 WHERE id=$3 RETURNING *',[status,String(req.body.notes||old.rows[0].notes||''),id]);
  await audit(req,old.rows[0].application_id,'EVC_STATUS_UPDATED',{visit_id:id,status}); res.json({visit:r.rows[0]});
});
app.get('/api/alerts',auth,async(req,res)=>{
  const r=req.user.role==='institution'?await query('SELECT al.*,a.reference_no FROM alerts al LEFT JOIN applications a ON a.id=al.application_id WHERE recipient_user_id=$1 ORDER BY created_at DESC',[req.user.id]):await query('SELECT al.*,a.reference_no FROM alerts al LEFT JOIN applications a ON a.id=al.application_id ORDER BY created_at DESC LIMIT 200');
  res.json({alerts:r.rows});
});
app.patch('/api/alerts/:id/read',auth,async(req,res)=>{
  if(req.user.role==='institution') await query('UPDATE alerts SET is_read=true WHERE id=$1 AND recipient_user_id=$2',[req.params.id,req.user.id]);
  else await query('UPDATE alerts SET is_read=true WHERE id=$1',[req.params.id]); res.json({ok:true});
});
app.get('/api/reports',auth,allow('regional_officer','bureau_officer','committee','admin'),async(req,res)=>{
  const r=await query(`SELECT stage,status,COUNT(*)::int AS count FROM applications GROUP BY stage,status ORDER BY stage`);
  const timeline=await query(`SELECT DATE(created_at) AS day,COUNT(*)::int AS actions FROM audit_logs WHERE created_at >= NOW()-INTERVAL '14 days' GROUP BY DATE(created_at) ORDER BY day`);
  res.json({stage_status:r.rows,timeline:timeline.rows});
});
app.get('/api/audit',auth,allow('regional_officer','bureau_officer','committee','admin'),async(req,res)=>{
  const r=await query(`SELECT al.*,a.reference_no FROM audit_logs al LEFT JOIN applications a ON a.id=al.application_id ORDER BY al.created_at DESC LIMIT 250`); res.json({logs:r.rows});
});
app.get('/api/rules',auth,allow('admin','regional_officer','bureau_officer'),async(req,res)=>{ const r=await query('SELECT * FROM workflow_rules ORDER BY rule_key,version DESC'); res.json({rules:r.rows}); });
app.post('/api/rules',auth,allow('admin'),async(req,res)=>{
  const key=String(req.body.rule_key||'').trim(); if(!key) return res.status(400).json({error:'Rule key is required.'});
  const current=await query('SELECT COALESCE(MAX(version),0)::int AS v FROM workflow_rules WHERE rule_key=$1',[key]);
  const r=await query('INSERT INTO workflow_rules(rule_key,version,enabled,config,approved_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[key,current.rows[0].v+1,req.body.enabled!==false,JSON.stringify(req.body.config||{}),req.user.name]);
  await audit(req,null,'WORKFLOW_RULE_VERSION_CREATED',{rule_key:key,version:r.rows[0].version}); res.status(201).json({rule:r.rows[0]});
});

// Daily deadline and expiry scanner; unique dedupe keys prevent repeated reminders.
async function runDeadlineScanner() {
  try {
    const apps=await query(`SELECT a.*,u.id AS applicant_user_id FROM applications a JOIN users u ON u.id=a.applicant_id WHERE a.status NOT IN ('Approved','Rejected')`);
    const today=new Date(); today.setHours(0,0,0,0);
    for(const a of apps.rows) {
      for(const [field,label] of [['due_date','Application deadline'],['compliance_due','Compliance due date'],['lease_expiry','Lease / document expiry']]) {
        if(!a[field]) continue; const due=new Date(a[field]); due.setHours(0,0,0,0); const days=Math.round((due-today)/86400000);
        if(days<=30) {
          const kind=days<0?'deadline':'expiry'; const title=days<0?`${label} overdue`:`${label} approaching`;
          const msg=days<0?`${label} passed ${Math.abs(days)} day(s) ago. Please review and update the record.`:`${label} is due in ${days} day(s). Please review the evidence and take action.`;
          const key=`scan-${a.id}-${field}-${a[field].toISOString ? a[field].toISOString().slice(0,10) : String(a[field]).slice(0,10)}-${days<0?'overdue':days}`;
          await notify(a.applicant_user_id,a.id,kind,title,msg,a[field],key);
          const admins=await query("SELECT id FROM users WHERE role IN ('regional_officer','bureau_officer','admin')");
          for(const u of admins.rows) await notify(u.id,a.id,kind,title,`${a.reference_no}: ${msg}`,a[field],key+`-${u.id}`);
        }
      }
    }
  } catch(e) { console.error('Deadline scanner error:',e.message); }
}
app.use((err,_req,res,_next)=>{ console.error(err); if(err instanceof multer.MulterError) return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File exceeds the 10 MB limit.':'Upload limit reached (10 files per request).'}); if(err.message && err.message.startsWith('Unsupported file type')) return res.status(400).json({error:err.message}); res.status(500).json({error:'Unexpected server error. Check the server log.'}); });

initDb().then(async()=>{ await runDeadlineScanner(); setInterval(runDeadlineScanner,24*60*60*1000); app.listen(PORT,()=>console.log(`AICTE SIH demo API listening on ${PORT}`)); }).catch(e=>{console.error('Database initialization failed:',e);process.exit(1);});
