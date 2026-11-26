/* هجمات على قواعد Firestore — تشتغل على المحاكي المحلي، ما تلمس قاعدة البيانات الحقيقية.
   التشغيل (يحتاج Java):
     npm i firebase-tools@15 @firebase/rules-unit-testing@4 firebase@11
     npx firebase emulators:exec --only firestore --project kln-test "node tests/firestore-rules.test.mjs"
   (مع firebase.json فيه: {"emulators":{"firestore":{"port":8085}}}) */
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,updateDoc,writeBatch,collection,getDocs,query,where} from 'firebase/firestore';
import fs from 'fs';
const env=await initializeTestEnvironment({projectId:'kln-test',firestore:{rules:fs.readFileSync(new URL('../firestore.rules', import.meta.url),'utf8'),host:'127.0.0.1',port:8085}});
const A='966500000001',B='966500000002';
const ua=env.authenticatedContext('ph_'+A,{ph:A}).firestore();
const ub=env.authenticatedContext('ph_'+B,{ph:B}).firestore();
const anon=env.unauthenticatedContext().firestore();
const adm=env.authenticatedContext('admin1',{email:'a@x'}).firestore();
await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();
  await setDoc(doc(d,'admins/admin1'),{n:'x'});
  await setDoc(doc(d,'counters/orders'),{n:5});
  await setDoc(doc(d,'orders/bOrder'),{uid:'ph_'+B,ph:B,st:'done',svc:'s',nt:'',items:[],est:100,no:1004});
  await setDoc(doc(d,'pins/'+B),{hash:'h',salt:'s'});});
const base={uid:'ph_'+A,ph:A,st:'new',svc:'تنظيف',nt:'',items:[{k:'x',t:'t',u:'u',p:100,q:1}],est:300,dep:150,off:0,hist:[]};
let pass=0,fail=0;
async function t(name,p){try{await p;console.log('✓',name);pass++;}catch(e){console.log('✗',name,'—',(e.message||e).slice(0,140));fail++;}}
let N=5;
function orderBatch(db,id,extra,_n){const n=N+1;const b=writeBatch(db);b.update(doc(db,'counters/orders'),{n:n});b.set(doc(db,'orders/'+id),Object.assign({},base,{no:1000+n},extra||{}));return b.commit().then(r=>{N=n;return r;});}

await t('طلب سليم مع رقم العدّاد ينقبل',assertSucceeds(orderBatch(ua,'okOrder1',{},6)));
await t('طلب فيه paid (مدفوع) يُرفض',assertFails(orderBatch(ua,'x2',{paid:999},7)));
await t('طلب فيه ostaz (فاتورة مزيفة) يُرفض',assertFails(orderBatch(ua,'x3',{ostaz:{id:67,url:'https://evil'}},7)));
await t('طلب فيه price يُرفض',assertFails(orderBatch(ua,'x4',{price:'1'},7)));
await t('طلب برقم جوال غيري يُرفض',assertFails(orderBatch(ua,'x5',{ph:B},7)));
await t('معرّف طلب فيه رموز (حقن في اللوحة) يُرفض',assertFails(orderBatch(ua,"x');alert(1)",{},7)));
await t('رقم طلب مكرر/مزوّر يُرفض',assertFails(orderBatch(ua,'x6',{no:1004},7)));
await t('عربون أكبر من الإجمالي يُرفض',assertFails(orderBatch(ua,'x7',{dep:5000},7)));
await t('خصم نصّي (حقن) يُرفض',assertFails(orderBatch(ua,'x8',{off:'<img src=x onerror=alert(1)>'},7)));
await t('قراءة طلب عميل ثاني تُرفض',assertFails(getDoc(doc(ua,'orders/bOrder'))));
await t('قراءة طلبي تنقبل',assertSucceeds(getDoc(doc(ua,'orders/okOrder1'))));
await t('سرد كل الطلبات بدون فلتر يُرفض',assertFails(getDocs(collection(ua,'orders'))));
await t('سرد طلباتي بالفلتر ينقبل',assertSucceeds(getDocs(query(collection(ua,'orders'),where('uid','==','ph_'+A)))));
await t('تعديل طلبي لـ paid يُرفض',assertFails(updateDoc(doc(ua,'orders/okOrder1'),{paid:300})));
await t('إلغاء طلبي الجديد ينقبل',assertSucceeds(updateDoc(doc(ua,'orders/okOrder1'),{st:'cancelled',hist:[{s:'cancelled'}]})));
await t('زائر بدون دخول ما يقرأ الطلبات',assertFails(getDoc(doc(anon,'orders/bOrder'))));
await t('رفع إيصال لطلبي ينقبل',assertSucceeds(setDoc(doc(ua,'receipts/okOrder1'),{uid:'ph_'+A,img:'data:image/jpeg;base64,AAAA',amt:150,at:'x'})));
await t('رفع إيصال على طلب غيري يُرفض',assertFails(setDoc(doc(ua,'receipts/bOrder'),{uid:'ph_'+A,img:'data:image/jpeg;base64,AAAA',amt:1,at:'x'})));
await t('قراءة إيصال غيري تُرفض',assertFails(getDoc(doc(ub,'receipts/okOrder1'))));
await t('قراءة رموز الدخول (pins) ممنوعة',assertFails(getDoc(doc(ua,'pins/'+B))));
await t('كتابة admins ممنوعة (ترقية نفسي لأدمن)',assertFails(setDoc(doc(ua,'admins/ph_'+A),{n:'x'})));
await t('ملف عميل برقم غيري يُرفض',assertFails(setDoc(doc(ua,'customers/ph_'+A),{ph:B,n:'x'})));
await t('ملف عميل برقمي ينقبل',assertSucceeds(setDoc(doc(ua,'customers/ph_'+A),{ph:A,n:'x'})));
await t('قراءة ملف عميل ثاني تُرفض',assertFails(getDoc(doc(ub,'customers/ph_'+A))));
await t('الأدمن يسجّل المستلم',assertSucceeds(updateDoc(doc(adm,'orders/bOrder'),{paid:100})));
await t('الأدمن يقرأ الإيصال',assertSucceeds(getDoc(doc(adm,'receipts/okOrder1'))));
await t('قراءة الإعدادات/الموظفين لغير الأدمن ممنوعة',assertFails(getDoc(doc(ua,'staff/x'))));
await t('تقييم بحقل زائد يُرفض',assertFails(setDoc(doc(anon,'reviews/r1'),{n:'a',ph:'0500000000',o:5,c:5,p:5,tw:5,r:true,nt:'',cp:'ABCDEFGHI',ts:'x',used:false,admin:true})));
await t('تقييم سليم من زائر ينقبل',assertSucceeds(setDoc(doc(anon,'reviews/r2'),{n:'a',ph:'0500000000',o:5,c:5,p:5,tw:5,r:true,nt:'',cp:'ABCDEFGHI',ts:'x',used:false})));
await t('زائر ما يقرأ التقييمات الخاصة',assertFails(getDoc(doc(anon,'reviews/r2'))));
/* ===== دخول بالإيميل ===== */
const E='ph_email_user_x';
const ue=env.authenticatedContext('emU1',{email:'a@b.c',firebase:{sign_in_provider:'password'}}).firestore();
const ue2=env.authenticatedContext('emU2',{email:'z@b.c',firebase:{sign_in_provider:'password'}}).firestore();
await t('إيميل: يحفظ جواله في ملفه',assertSucceeds(setDoc(doc(ue,'customers/emU1'),{ph:'966511112222',n:'x',em:'a@b.c'})));
await t('إيميل: جوال بصيغة غلط يُرفض',assertFails(setDoc(doc(ue2,'customers/emU2'),{ph:'12345',n:'x'})));
await t('إيميل: ملف عميل ثاني يُرفض',assertFails(setDoc(doc(ue2,'customers/emU1'),{ph:'966511112222'})));
const be=(db,id,ph,n)=>{const b=writeBatch(db);b.update(doc(db,'counters/orders'),{n:n});b.set(doc(db,'orders/'+id),Object.assign({},base,{uid:db===ue?'emU1':'emU2',ph:ph,no:1000+n}));return b.commit();};
await t('إيميل: طلب بجوال ملفه ينقبل',assertSucceeds(be(ue,'emOrd1','966511112222',N+1).then(r=>{N=N+1;return r;})));
await t('إيميل: طلب بجوال غير اللي في ملفه يُرفض',assertFails(be(ue,'emOrd2','966599998888',N+1)));
await t('إيميل بلا ملف: طلب يُرفض',assertFails(be(ue2,'emOrd3','966511112222',N+1)));
await t('دخول جوال (PIN) ما يقدر يدّعي أنه إيميل',assertFails(setDoc(doc(ua,'customers/ph_'+A),{ph:'966577776666'})));
console.log('\n'+pass+' passed, '+fail+' failed');
await env.cleanup();process.exit(fail?1:0);
