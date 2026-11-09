import http from 'http';
import { createPresuVozHttpServer } from '../src/cloud_api_adapter.js';

const server = createPresuVozHttpServer();
server.listen(4899, '127.0.0.1', async () => {
  console.log('Server started on 4899');
  
  // Test 1: GET /demo
  const res1 = await fetch('http://127.0.0.1:4899/demo');
  const text1 = await res1.text();
  console.log('GET /demo status:', res1.status, 'HTML length:', text1.length, 'Contains title:', text1.includes('Demostración en Vídeo'));
  
  // Test 2: GET /presuvoz_demo_e2e_editada.mp4 with Range header
  const res2 = await fetch('http://127.0.0.1:4899/presuvoz_demo_e2e_editada.mp4', {
    headers: { 'Range': 'bytes=0-1023' }
  });
  console.log('GET /presuvoz_demo_e2e_editada.mp4 status:', res2.status, 'Content-Range:', res2.headers.get('content-range'), 'Content-Type:', res2.headers.get('content-type'));

  server.close(() => console.log('Server closed cleanly.'));
});
