import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { createHandlers } from './handlers.mjs';

export const info = { id:'naice-shot',name:'NAIce Shot server',description:'Character-slot image generation with the current user’s stored NovelAI key.' };
export async function init(router) {
  const handlers=createHandlers({readKey:directories=>readSecret(directories,SECRET_KEYS.NOVEL)});
  router.get('/status',handlers.status);
  router.get('/history',handlers.history);
  router.post('/generate',handlers.generate);
  router.post('/delete',handlers.delete);
  console.info('[NAIce Shot] server ready');
}
