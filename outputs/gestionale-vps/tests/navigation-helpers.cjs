'use strict';

// Calendar and parking are independent, direct sidebar controls.
async function selectAgenda(frame, view = 'agenda') {
  await frame.locator(`.nav [data-view="${view}"]`).click();
  await frame.page().waitForFunction(view => {
    const cloud = document.querySelector('iframe')?.contentWindow?.WorkshopCloud;
    return cloud && !cloud.initializing && !window.WorkshopCloudHost.synchronizing() && cloud.view() === view;
  }, view);
  return frame.page().frames().find(item => item.url().includes('/legacy'));
}

module.exports = {selectAgenda};
