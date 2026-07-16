const talkUrl = "/";

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Yurume", {
      body: "新しいトークがあります。Yurumeで確認してください。",
      icon: "/yurumeet-logo.png",
      tag: "yurume-talk",
      data: { url: talkUrl },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openProductWindow(event.notification.data?.url));
});

async function openProductWindow(path) {
  const target = new URL(path || talkUrl, self.location.origin).href;
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    await client.navigate(target);
    return await client.focus();
  }
  return await self.clients.openWindow(target);
}
