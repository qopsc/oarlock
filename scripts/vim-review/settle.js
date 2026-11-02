export async function awaitVimIdle(cm) {
  await Promise.resolve();
  if (!cm?.vimTicket?.()) return;
  for (let i=0;i<1000;i++) {
    await new Promise(resolve=>setTimeout(resolve,1));
    if (!cm?.vimTicket?.()) return;
  }
  throw Error('Vim command did not settle');
}
