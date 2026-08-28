/* يجهّز مجلد www/ اللي يبنيه Capacitor داخل تطبيق آيفون.
   ننسخ ملفات الويب كما هي، ونصلّح مسار الشعار لأنه خارج مجلد app/. */
import { mkdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const www  = join(here, 'www');

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });

/* الصور تنتقل جنب الصفحة، فالمسار «‎../اسم.png» يصير «اسم.png» */
const IMGS = ['logo.png', 'icon.png', 'icon-192.png', 'icon-512.png'];
let html = await readFile(join(here, 'index.html'), 'utf8');
for (const f of IMGS) html = html.replaceAll('../' + f, f);

/* الـService Worker للويب فقط — داخل التطبيق الأصلي يخدّم نسخة قديمة بلا فائدة */
html = html.replace(
  /\/\* الملف في الجذر[\s\S]*?\n}\n/,
  '/* لا Service Worker داخل التطبيق الأصلي — التحديث يجي من المتجر */\n'
);

await writeFile(join(www, 'index.html'), html);
let man = await readFile(join(here, 'manifest.json'), 'utf8');
for (const f of IMGS) man = man.replaceAll('../' + f, f);
await writeFile(join(www, 'manifest.json'), man);
for (const f of IMGS) await copyFile(join(root, f), join(www, f));

console.log('✓ www/ جاهز — شغّل: npx cap sync ios');
