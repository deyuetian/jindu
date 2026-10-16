import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
const c=JSON.parse(readFileSync(process.env.JINDU_CONFIG,'utf8'));
const tls=!!(c.tlsCert&&c.tlsKey),transport=tls?https:http;
const req=transport.get({hostname:'127.0.0.1',port:c.port||8788,path:'/api/health',headers:{Host:new URL(c.origin).host},timeout:3500,...(tls?{servername:new URL(c.origin).hostname,ca:readFileSync(c.tlsCA||c.tlsCert)}:{})},res=>{res.resume();res.on('end',()=>process.exit(res.statusCode===200?0:1));});
req.on('error',()=>process.exit(1));req.on('timeout',()=>req.destroy());
