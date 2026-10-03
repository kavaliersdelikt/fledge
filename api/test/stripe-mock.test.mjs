import test from 'node:test';
import assert from 'node:assert/strict';
import {startStripeMock} from './stripe-mock.mjs';

test('Stripe mock hides internal errors from API responses',async()=>{
 const mock=await startStripeMock({webhookUrl:'http://127.0.0.1:1/webhook'});
 try{
  mock.state.subs.sub_test={};
  const response=await fetch(`http://127.0.0.1:${mock.port}/v1/subscriptions/sub_test`,{
   method:'POST',
   headers:{authorization:'Bearer sk_test_mock','content-type':'application/x-www-form-urlencoded'},
   body:'items[0][unit_amount]=100',
  });
  const payload=await response.json();
  assert.equal(response.status,500);
  assert.equal(payload.error.message,'Internal server error');
  assert.equal(payload.error.type,'api_error');
  assert.doesNotMatch(JSON.stringify(payload),/TypeError|Cannot read properties|stripe-mock\.mjs/);
 }finally{
  await mock.stop();
 }
});
