import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { createHandlers } from './handlers.mjs';

export const info = { id:'naice-shot',name:'NAIce Shot server',description:'Character-slot image generation with the current user’s stored NovelAI key.' };
export async function init(router) {
  const handlers=createHandlers({readKey:directories=>readSecret(directories,SECRET_KEYS.NOVEL)});
  router.get('/status',handlers.status);
  router.get('/history',handlers.history);
  router.post('/history',handlers.history);
  router.get('/draft',handlers.draft);
  router.post('/draft',handlers.draft);
  router.post('/generate',handlers.generate);
  router.get('/generation',handlers.generation);
  router.post('/generation',handlers.generation);
  router.post('/delete',handlers.delete);
  router.post('/delete-check',handlers.deleteCheck);
  console.info('[NAIce Shot] server ready');
}
