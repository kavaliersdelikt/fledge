// Run with: npx tsx --test test/branding.test.ts
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkAsset,defaultBranding,publicBranding,PUBLIC_KEYS,readBranding,sanitizeCss,senderWithName,sniffImage,validateBranding,CSS_LIMIT} from '../src/branding.ts';

const png=(w=64,h=64)=>{const b=Buffer.alloc(33);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12,'ascii');b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;};
const jpeg=(w=80,h=40)=>{const b=Buffer.alloc(30);b[0]=0xff;b[1]=0xd8;b[2]=0xff;b[3]=0xe0;b.writeUInt16BE(4,4);b[8]=0xff;b[9]=0xc0;b.writeUInt16BE(17,10);b[12]=8;b.writeUInt16BE(h,13);b.writeUInt16BE(w,15);return b;};
const webpLossless=(w=32,h=16)=>{const b=Buffer.alloc(40);b.write('RIFF',0);b.writeUInt32LE(32,4);b.write('WEBPVP8L',8);b[20]=0x2f;b.writeUInt32LE((w-1)|((h-1)<<14),21);return b;};
const ico=()=>{const b=Buffer.alloc(30);b.writeUInt16LE(0,0);b.writeUInt16LE(1,2);b.writeUInt16LE(1,4);b[6]=32;b[7]=32;return b;};
const svg=(inner='<rect width="10" height="10" fill="#f00"/>')=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`);

test('image headers give type and size',()=>{
  assert.deepEqual(sniffImage(png(120,48)),{mime:'image/png',width:120,height:48});
  assert.deepEqual(sniffImage(jpeg(80,40)),{mime:'image/jpeg',width:80,height:40});
  assert.deepEqual(sniffImage(webpLossless(32,16)),{mime:'image/webp',width:32,height:16});
  assert.deepEqual(sniffImage(ico()),{mime:'image/x-icon',width:32,height:32});
  assert.equal(sniffImage(svg())?.mime,'image/svg+xml');
  assert.equal(sniffImage(Buffer.from('GIF89a......')),null);
  assert.equal(sniffImage(Buffer.from('not an image at all, just text')),null);
  assert.equal(sniffImage(Buffer.alloc(0)),null);
  assert.equal(sniffImage(png().subarray(0,12)),null,'a truncated PNG must not throw');
  assert.equal(sniffImage(Buffer.from([0xff,0xd8,0xff,0xe0,0xff,0xff])),null,'a truncated JPEG must not throw');
});

test('uploads are checked against the slot',()=>{
  assert.equal(checkAsset('mark',png(256,256)).mime,'image/png');
  assert.throws(()=>checkAsset('mark',png(2000,2000)),/largest allowed is 1024×1024/);
  assert.throws(()=>checkAsset('login',svg()),/JPEG, WEBP, PNG/);
  assert.throws(()=>checkAsset('favicon',jpeg()),/PNG, ICO, SVG, WEBP/);
  assert.equal(checkAsset('favicon',ico()).mime,'image/x-icon');
  assert.throws(()=>checkAsset('mark',Buffer.alloc(0)),/empty/);
  assert.throws(()=>checkAsset('mark',Buffer.concat([png(),Buffer.alloc(600*1024)])),/at most 512 KB/);
  assert.throws(()=>checkAsset('mark',Buffer.from('<html>hi</html>')),/not a PNG/);
  assert.match(checkAsset('mark',png()).sha256,/^[a-f0-9]{64}$/);
});

test('hostile SVGs are refused',()=>{
  const hostile:[string,RegExp][]=[
    ['<script>alert(1)</script>',/scripts/],
    ['<foreignObject><div/></foreignObject>',/foreignObject/],
    ['<rect onload="x()" width="1" height="1"/>',/event handlers/],
    ['<a href="https://evil.example/"><rect width="1" height="1"/></a>',/external references/],
    ['<image href="data:image/png;base64,AAAA"/>',/external references/],
    ['<rect style="fill:url(https://evil.example/x)" width="1" height="1"/>',/external references/],
    ['<style>@import url(https://evil.example/x.css);</style>',/embedded content or styles/],
    ['<iframe src="x"/>',/embedded content/],
    ['<animate attributeName="href" values="javascript:alert(1)"/>',/embedded content/],
    ['<use href="https://evil.example/#a"/>',/embedded content|external/],
  ];
  for(const [inner,why] of hostile)assert.throws(()=>checkAsset('mark',svg(inner)),why,inner);
  assert.throws(()=>checkAsset('mark',Buffer.from('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"></svg>')),/DOCTYPE/);
  // Plain shapes, gradients and fragment references are fine.
  assert.equal(checkAsset('mark',svg('<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect fill="url(#g)" width="1" height="1"/><rect fill="url(&quot;#g&quot;)" width="1" height="1"/>')).mime,'image/svg+xml');
  assert.equal(checkAsset('mark',Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>')).mime,'image/svg+xml');
});

test('custom CSS: ordinary styling passes',()=>{
  const css=`/* brand */ .brand span{letter-spacing:.04em} @media (max-width:600px){.sidebar{width:200px}} .auth{background:url("/branding/login") center/cover}
    .x{background:url(#grad);content:"a{b}"} .y{background-image:url(data:image/png;base64,iVBORw0KGgo=)}`;
  const r=sanitizeCss(css);
  assert.deepEqual(r.problems,[]);
  assert.ok(!r.css.includes('/*'));
});

test('custom CSS: anything that could reach another server or run code is refused',()=>{
  const bad:[string,RegExp][]=[
    ['@import url(https://evil.example/a.css);',/@import/],
    ['@IMPORT "x.css";',/@import/],
    ['.a{background:url(https://evil.example/p.png)}',/url\(\) may only/],
    ['.a{background:url(//evil.example/p.png)}',/url\(\) may only/],
    ['.a{background:url( "http://evil.example/p" )}',/url\(\) may only/],
    ['.a{background:ur\\6c(https://evil.example/p)}',/url\(\) may only/],
    ['.a{background:\\75rl(https://evil.example/p)}',/url\(\) may only/],
    ['.a{background:image-set("https://evil.example/p" 1x)}',/image-set/],
    ['.a{content:src("x")}',/image function/],
    ['@font-face{font-family:x;src:url(https://evil.example/f.woff2)}',/@font-face/],
    ['.a{width:expression(alert(1))}',/expression/],
    ['.a{behavior:url(x.htc)}',/behavior/],
    ['.a{-moz-binding:url(x)}',/-moz-binding/],
    ['</style><script>alert(1)</script>',/HTML tags/],
    ['.a{background:url(javascript:alert(1))}',/script URLs|url\(\) may only/],
    ['@namespace url(http://evil.example);',/@namespace/],
    ['.a{color:red',/unbalanced/],
    ['.a{color:red}}',/unbalanced/],
    ['.a{content:"‮"}',/invisible/],
  ];
  for(const [css,why] of bad)assert.match(sanitizeCss(css).problems.join('|'),why,css);
  assert.match(sanitizeCss('x'.repeat(CSS_LIMIT+1)).problems[0],/at most 32 KB/);
  assert.match(sanitizeCss(`.a{background:url(data:image/png;base64,${'A'.repeat(30000)})}`).problems.join('|'),/larger than 20 KB/);
  // A comment cannot hide a payload, and an unterminated one swallows the rest instead of letting it through.
  assert.deepEqual(sanitizeCss('.a{color:red} /* @import "x"; */').problems,[]);
});

test('the default document validates and is private by default',()=>{
  const d=defaultBranding();
  assert.equal(validateBranding(JSON.parse(JSON.stringify(d))).identity.name,'Fledge');
  const pub=publicBranding(d,false,'0.6.2.1');
  assert.deepEqual(Object.keys(pub).sort(),[...PUBLIC_KEYS].sort());
  assert.equal(pub.customCss,'');
  assert.equal(pub.images.mark,null);
  assert.equal(pub.announcement,null);
  assert.equal(pub.theme.css.includes('data-mode="light"'),true);
});

test('the public document never carries private fields',()=>{
  const d=defaultBranding();
  d.advanced={customCssEnabled:false,customCss:'.secret-marker{color:red}'};
  d.identity.emailFromName='Mailer Person';d.email.footer='footer marker';
  d.announcement={enabled:true,tone:'warn',text:'for customers only',audience:'customers',dismissible:true,startsAt:null,endsAt:null,id:'a1'};
  const json=JSON.stringify(publicBranding(d,false,''));
  for(const secret of ['secret-marker','Mailer Person','footer marker','for customers only','customCssEnabled','emailFromName'])assert.ok(!json.includes(secret),secret);
  d.announcement.audience='everyone';
  assert.equal(publicBranding(d,false,'').announcement?.text,'for customers only');
  d.announcement.startsAt=new Date(Date.now()+3600e3).toISOString();
  assert.equal(publicBranding(d,false,'').announcement,null,'not started yet');
  d.announcement.startsAt=new Date(Date.now()-7200e3).toISOString();d.announcement.endsAt=new Date(Date.now()-3600e3).toISOString();
  assert.equal(publicBranding(d,false,'').announcement,null,'already over');
  d.advanced={customCssEnabled:true,customCss:'.ok{color:red}'};
  assert.equal(publicBranding(d,false,'').customCss,'.ok{color:red}');
});

test('names, links and text are validated',()=>{
  const with_=(patch:(d:any)=>void)=>{const d:any=JSON.parse(JSON.stringify(defaultBranding()));patch(d);return d;};
  assert.throws(()=>validateBranding(with_(d=>{d.identity.name='';})),/Panel name cannot be empty/);
  assert.throws(()=>validateBranding(with_(d=>{d.identity.name='x'.repeat(41);})),/at most 40/);
  assert.throws(()=>validateBranding(with_(d=>{d.identity.name='Acme‮';})),/characters that are not allowed/);
  assert.throws(()=>validateBranding(with_(d=>{d.identity.name='Ac​me';})),/characters that are not allowed/);
  assert.throws(()=>validateBranding(with_(d=>{d.identity.name='two\nlines';})),/characters that are not allowed/);
  assert.throws(()=>validateBranding(with_(d=>{d.identity.shortName='x'.repeat(13);})),/at most 12/);
  assert.throws(()=>validateBranding(with_(d=>{d.identity.sourceUrl='javascript:alert(1)';})),/must start with/);
  assert.throws(()=>validateBranding(with_(d=>{d.identity.sourceUrl='https://user:pw@example.com/';})),/username/);
  assert.throws(()=>validateBranding(with_(d=>{d.navigation.links=[{label:'x',url:'javascript:alert(1)',icon:'link',newTab:true}];})),/must start with/);
  assert.throws(()=>validateBranding(with_(d=>{d.navigation.links=[{label:'x',url:'https://e.example',icon:'skull',newTab:true}];})),/icon must be one of/);
  assert.throws(()=>validateBranding(with_(d=>{d.navigation.links=Array.from({length:9},()=>({label:'x',url:'https://e.example',icon:'link',newTab:true}));})),/at most 8/);
  assert.throws(()=>validateBranding(with_(d=>{d.navigation.labels={bogus:'x'};})),/not a navigation entry/);
  assert.throws(()=>validateBranding(with_(d=>{d.login.footerLinks=[{label:'x',url:'ftp://e.example',icon:'link',newTab:true}];})),/must start with/);
  assert.throws(()=>validateBranding(with_(d=>{d.announcement.enabled=true;d.announcement.text='';})),/Write the announcement text/);
  assert.throws(()=>validateBranding(with_(d=>{d.announcement.startsAt='2026-01-02T00:00:00Z';d.announcement.endsAt='2026-01-01T00:00:00Z';})),/end after it starts/);
  assert.throws(()=>validateBranding(with_(d=>{d.advanced={customCssEnabled:true,customCss:'@import "x";'};})),/Custom CSS/);
  assert.throws(()=>validateBranding(with_(d=>{d.assets.mark='nothex';})),/mark image is not valid/);
  const ok=validateBranding(with_(d=>{d.identity.name='  Acme Hosting  ';d.navigation.labels={servers:'Worlds'};d.navigation.links=[{label:'Status',url:'https://status.example.com',icon:'activity',newTab:true}];}));
  assert.equal(ok.identity.name,'Acme Hosting');
  assert.equal(ok.navigation.labels.servers,'Worlds');
});

test('unreadable colours cannot be saved, but a stored document always renders',()=>{
  const bad:any=JSON.parse(JSON.stringify(defaultBranding()));
  bad.theme.dark.overrides={...bad.theme.dark.overrides,text:'#2a2a27'};
  assert.throws(()=>validateBranding(bad),/not readable enough/);
  const {doc,warnings}=readBranding(bad);
  assert.equal(doc.theme.dark.overrides?.text,'#ece9e2','falls back to the default theme');
  assert.ok(warnings.some(w=>w.startsWith('theme:')));
  const partial=readBranding({schemaVersion:1,revision:3,identity:{name:'Acme',shortName:'',tagline:'',emailFromName:'',sourceUrl:'',showPoweredBy:true}});
  assert.equal(partial.doc.identity.name,'Acme');
  assert.equal(partial.doc.revision,3);
  assert.deepEqual(partial.warnings,[],'missing sections are just defaults');
  const broken=readBranding({schemaVersion:1,identity:{name:''},login:'nope'});
  assert.equal(broken.doc.identity.name,'Fledge');
  assert.equal(broken.warnings.length,2);
});

test('a sender name is added only when the address has none',()=>{
  assert.equal(senderWithName('panel@example.com','Acme'),'"Acme" <panel@example.com>');
  assert.equal(senderWithName('Ops <panel@example.com>','Acme'),'Ops <panel@example.com>');
  assert.equal(senderWithName('panel@example.com',''),'panel@example.com');
  assert.equal(senderWithName('panel@example.com','Ac"me\r\nBcc: x'),'"AcmeBcc: x" <panel@example.com>');
});
