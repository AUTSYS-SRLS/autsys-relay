import test from 'node:test';
import assert from 'node:assert/strict';
import {validateV2AuthorizationMetadata,checkV2AuthorizationServer} from './staging-mcp-v2-oauth-preflight.mjs';
const issuer='https://identity.example.test';
const good={issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],client_id_metadata_document_supported:true,scopes_supported:['autsys.v2.read','offline_access'],authorization_response_iss_parameter_supported:true};
test('MCP OAuth preflight accepts valid PKCE + CIMD discovery',()=>{
 const result=validateV2AuthorizationMetadata(good,{issuer});
 assert.equal(result.ok,true);assert.equal(result.clientRegistration,'CIMD');assert.equal(result.warnings.length,0);
});
test('MCP OAuth preflight rejects missing S256, wrong issuer and HTTP endpoints',()=>{
 const result=validateV2AuthorizationMetadata({...good,issuer:'https://attacker.example.test',authorization_endpoint:'http://not-secure/authorize',code_challenge_methods_supported:['plain']},{issuer});
 assert.equal(result.ok,false);assert.ok(result.failures.includes('ISSUER_MISMATCH'));
 assert.ok(result.failures.includes('AUTHORIZATION_ENDPOINT_INVALID'));
 assert.ok(result.failures.includes('PKCE_S256_NOT_ADVERTISED'));
});
test('MCP OAuth preflight identifies missing client registration and scope warnings',()=>{
 const result=validateV2AuthorizationMetadata({...good,client_id_metadata_document_supported:false,scopes_supported:[],token_endpoint_auth_methods_supported:[]},{issuer});
 assert.equal(result.ok,true);assert.equal(result.clientRegistration,'PRE_REGISTERED');assert.ok(result.warnings.includes('CLIENT_PRE_REGISTRATION_REQUIRED'));
});
test('MCP OAuth discovery fetch validates public metadata without credentials',async()=>{
 const result=await checkV2AuthorizationServer({issuer,metadataUrl:issuer+'/.well-known/oauth-authorization-server',fetchImpl:async (url,options)=>{
  assert.equal(options.redirect,'error');assert.ok(!('authorization' in options.headers));
  return {ok:true,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify(good)};
 }});
 assert.equal(result.ok,true);
});
