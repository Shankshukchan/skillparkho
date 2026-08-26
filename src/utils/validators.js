import { normalizePhoneNumber } from './phoneNormalizer.js';

const jobPositions = [
  'Desktop Support Engineer','IT Support Engineer','System Engineer','Network Support Engineer','Technical Support Associate','Help Desk Engineer','Windows Support Engineer','Cloud Support Associate','Server Support Engineer','Other'
];
const interviewRounds = ['HR Screening','Technical Round 1','Technical Round 2','Managerial Round','Client Round','HR & Salary Discussion','General Call / Follow-up'];
const allowedAudioExt = ['aac','m4a','mp3','wav','amr','3gp'];
const missingReasons = ['I will upload later','Recording not available','HR requested not to record','Phone does not support recording','Recording failed'];

export function validatePhone(phone, field='phone_number'){
  const norm = normalizePhoneNumber(phone);
  if (!norm) return `${field} is required`;
  if (!/^\d{10}$/.test(norm)) return `${field} must be 10 digits`;
  if (/^(\d)\1{9}$/.test(norm)) return `${field} is invalid`;
  return null;
}
export function validateHrName(v){
  if (!v || !v.trim()) return 'hr_name is required';
  const t=v.trim();
  if (t.length<2) return 'hr_name must be ≥2 chars';
  if (t.length>50) return 'hr_name must be ≤50 chars';
  if (!/^[A-Za-z\s.\-']+$/.test(t)) return 'hr_name contains invalid characters';
  return null;
}
export function validateCompany(v){
  if (!v || !v.trim()) return 'company_name is required';
  const t=v.trim();
  if (t.length<2) return 'company_name must be ≥2 chars';
  if (t.length>100) return 'company_name must be ≤100 chars';
  if (!/^[A-Za-z0-9\s.,\-\&\(\)]+$/.test(t)) return 'company_name contains invalid characters';
  return null;
}
export function validateLocation(v, required=false){
  if (!v || !v.trim()) return required? 'location is required': null;
  const t=v.trim();
  if (t.length<2) return 'location must be ≥2 chars';
  if (t.length>100) return 'location must be ≤100 chars';
  if (!/^[A-Za-z0-9\s.,\-]+$/.test(t)) return 'location contains invalid characters';
  return null;
}
export function validateDesignation(v, required=false){
  if (!v || !v.trim()) return required? 'hr_designation is required': null;
  const t=v.trim();
  if (t.length<2) return 'hr_designation must be ≥2 chars';
  if (t.length>100) return 'hr_designation must be ≤100 chars';
  if (!/^[A-Za-z0-9\s.,\-\&\(\)]+$/.test(t)) return 'hr_designation contains invalid characters';
  return null;
}
export function validateJobPosition(selected, other){
  if (!selected) return 'job_position_called_for is required';
  if (selected==='Other'){
    const t=(other||'').trim();
    if (!t) return 'custom job position is required when Other';
    if (t.length<2) return 'custom position must be ≥2 chars';
    if (t.length>100) return 'custom position must be ≤100 chars';
    if (!/^[A-Za-z0-9\s.,\-\&\(\)\/]+$/.test(t)) return 'custom position contains invalid characters';
  } else if (!jobPositions.includes(selected)) return 'invalid job_position_called_for';
  return null;
}
export function validateHrEmail(v){
  if (v === undefined || v === null || String(v).trim() === '') return null; // optional
  const t = String(v).trim();
  if (t.length > 254) return 'hr_email must be ≤254 chars';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return 'hr_email must be a valid email';
  return null;
}
export function validateHrPayload(p, isUpdate=false){
  const errs={};
  if (!isUpdate || p.phone_number!==undefined) {
    const e=validatePhone(p.phone_number); if(e) errs.phone_number=e;
  }
  if (!isUpdate || p.hr_name!==undefined) { const e=validateHrName(p.hr_name); if(e) errs.hr_name=e; }
  if (!isUpdate || p.company_name!==undefined) { const e=validateCompany(p.company_name); if(e) errs.company_name=e; }
  if (p.hr_email!==undefined) { const e=validateHrEmail(p.hr_email); if(e) errs.hr_email=e; }
  if (!isUpdate || p.location!==undefined) { const e=validateLocation(p.location, true); if(e) errs.location=e; }
  if (p.hr_designation!==undefined) { const e=validateDesignation(p.hr_designation); if(e) errs.hr_designation=e; }
  if (!isUpdate || p.job_position_called_for!==undefined) {
    // For backend, other is same as job_position if not Other? Just validate against list or allow custom if not in list
    let sel = p.job_position_called_for;
    let other = '';
    if (sel && !jobPositions.includes(sel)) { other=sel; sel='Other'; }
    const e=validateJobPosition(sel, other);
    if(e) errs.job_position_called_for=e;
  }
  if (p.normalized_phone_number) {
    const e=validatePhone(p.normalized_phone_number, 'normalized_phone_number'); if(e) errs.normalized_phone_number=e;
  }
  return Object.keys(errs).length? errs: null;
}

export function validateCallLogPayload(p){
  const errs={};
  if (!p.phone_number) errs.phone_number='phone_number required';
  else { const e=validatePhone(p.phone_number); if(e) errs.phone_number=e; }
  if (!p.call_type || !['INCOMING','OUTGOING','MISSED','REJECTED'].includes(p.call_type)) errs.call_type='call_type must be INCOMING/OUTGOING/MISSED/REJECTED';
  if (p.duration_seconds!=null && (!Number.isInteger(p.duration_seconds) || p.duration_seconds<0 || p.duration_seconds> 24*3600)) errs.duration_seconds='duration_seconds invalid';
  if (!p.start_time) errs.start_time='start_time required';
  else if (isNaN(Date.parse(p.start_time))) errs.start_time='start_time invalid ISO';
  if (!p.end_time) errs.end_time='end_time required';
  else if (isNaN(Date.parse(p.end_time))) errs.end_time='end_time invalid ISO';
  if (p.start_time && p.end_time && !errs.start_time && !errs.end_time) {
    if (new Date(p.start_time) > new Date(p.end_time)) errs.end_time='end_time must be after start_time';
  }
  if (p.interview_rating!=null && (p.interview_rating<1 || p.interview_rating>5)) errs.interview_rating='interview_rating 1-5';
  if (p.interview_round && !interviewRounds.includes(p.interview_round)) errs.interview_round='invalid interview_round';
  if (p.interview_notes && p.interview_notes.length>2000) errs.interview_notes='interview_notes ≤2000';
  if (p.interview_next_steps && p.interview_next_steps.length>500) errs.interview_next_steps='interview_next_steps ≤500';
  if (p.interview_topics && !Array.isArray(p.interview_topics)) errs.interview_topics='interview_topics must be array';
  if (p.interview_topics && p.interview_topics.length>12) errs.interview_topics='max 12 topics';
  if (p.interview_questions && !Array.isArray(p.interview_questions)) errs.interview_questions='interview_questions must be array';
  if (p.interview_questions && p.interview_questions.some(q=> typeof q!=='string' || q.length<5 || q.length>500)) errs.interview_questions='each question 5-500 chars';
  if (p.pending_reason && !missingReasons.includes(p.pending_reason)) errs.pending_reason='invalid pending_reason';
  if (p.reminder_status && !['not_required','pending','completed','reason_provided'].includes(p.reminder_status)) errs.reminder_status='invalid reminder_status';
  if (p.storage_path && p.storage_path.length>500) errs.storage_path='storage_path too long';
  return Object.keys(errs).length? errs: null;
}

export function validateRecordingPayload(p){
  const errs={};
  if (!p.phone_number && !p.call_log_id) errs.call_log_id='call_log_id required';
  if (!p.original_filename || p.original_filename.trim().length<1) errs.original_filename='original_filename required';
  if (p.original_filename && p.original_filename.length>255) errs.original_filename='filename too long';
  if (p.file_size_bytes!=null && (p.file_size_bytes<=0 || p.file_size_bytes>50*1024*1024)) errs.file_size_bytes='file_size 1-50MB';
  if (p.mime_type && !/^(audio|video)\//.test(p.mime_type) && !allowedAudioExt.some(e=> p.original_filename?.toLowerCase().endsWith('.'+e))) errs.mime_type='invalid mime';
  return Object.keys(errs).length? errs:null;
}
