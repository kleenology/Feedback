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

/* الشعار ينتقل جنب الصفحة، فالمسار «‎../logo.png» يصير «logo.png» */
let html = await readFile(join(here, 'index.html'), 'utf8');
html = html.replaceAll('../logo.png', 'logo.png');

/* الـService Worker للويب فقط — داخل التطبيق الأصلي يخدّم نسخة قديمة بلا فائدة */
html = html.replace(
  /\/\* الملف في الجذر[\s\S]*?\n}\n/,
  '/* لا Service Worker داخل التطبيق الأصلي — التحديث يجي من المتجر */\n'
);

await writeFile(join(www, 'index.html'), html);
await copyFile(join(here, 'manifest.json'), join(www, 'manifest.json'));
await copyFile(join(root, 'logo.png'), join(www, 'logo.png'));

console.log('✓ www/ جاهز — شغّل: npx cap sync ios');
