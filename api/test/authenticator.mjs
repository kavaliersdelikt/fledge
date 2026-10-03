// A software WebAuthn authenticator for tests: makes "none"-attestation registrations and ES256
// assertions that @simplewebauthn/server accepts, so passkey flows can be tested without a browser.
import {generateKeyPairSync,createHash,sign,randomBytes} from 'node:crypto';
// Minimal CBOR writer for the attestation object (definite lengths only, which is what real authenticators emit).
const head=(major,n)=>n<24?Buffer.from([major<<5|n]):n<256?Buffer.from([major<<5|24,n]):Buffer.from([major<<5|25,n>>8,n&255]);
const cborText=t=>Buffer.concat([head(3,Buffer.byteLength(t)),Buffer.from(t)]);
const cborBytes=b=>Buffer.concat([head(2,b.length),b]);
const encode=({fmt,authData})=>Buffer.concat([Buffer.from([0xa3]),cborText('fmt'),cborText(fmt),cborText('attStmt'),Buffer.from([0xa0]),cborText('authData'),cborBytes(authData)]);
const b64u=b=>Buffer.from(b).toString('base64url');
export function makeAuthenticator({origin='http://localhost:3000',rpId='localhost'}={}){
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 const jwk=publicKey.export({format:'jwk'});
 // COSE_Key for ES256, written by hand so the integer map keys are plain CBOR integers.
 const cose=Buffer.concat([Buffer.from([0xa5,0x01,0x02,0x03,0x26,0x20,0x01,0x21,0x58,0x20]),Buffer.from(jwk.x,'base64url'),Buffer.from([0x22,0x58,0x20]),Buffer.from(jwk.y,'base64url')]);
 const credId=randomBytes(32),rpHash=createHash('sha256').update(rpId).digest();
 let counter=0;
 const json=(type,challenge,o)=>Buffer.from(JSON.stringify({type,challenge,origin:o||origin,crossOrigin:false}));
 return {
  credentialId:b64u(credId),
  register(options,{originOverride}={}){
   const clientData=json('webauthn.create',options.challenge,originOverride);
   const credData=Buffer.concat([Buffer.alloc(16),Buffer.from([credId.length>>8,credId.length&255]),credId,cose]);
   const authData=Buffer.concat([rpHash,Buffer.from([0x45]),Buffer.alloc(4),credData]);
   return {id:b64u(credId),rawId:b64u(credId),type:'public-key',response:{clientDataJSON:b64u(clientData),attestationObject:b64u(encode({fmt:'none',attStmt:{},authData})),transports:['internal']},clientExtensionResults:{}};
  },
  assert(options,{tamper=false,replay=false,originOverride}={}){
   if(!replay)counter++;
   const clientData=json('webauthn.get',options.challenge,originOverride),cb=Buffer.alloc(4);cb.writeUInt32BE(counter);
   const authData=Buffer.concat([rpHash,Buffer.from([0x05]),cb]);
   const signature=sign('sha256',Buffer.concat([authData,createHash('sha256').update(clientData).digest()]),privateKey);
   return {id:b64u(credId),rawId:b64u(credId),type:'public-key',response:{clientDataJSON:b64u(clientData),authenticatorData:b64u(authData),signature:b64u(tamper?Buffer.alloc(signature.length):signature),userHandle:null},clientExtensionResults:{}};
  }
 };
}
