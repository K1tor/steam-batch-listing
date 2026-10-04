// 读取 steamcommunity.com 的会话 cookie(含 HttpOnly),供内容脚本调用
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "getSteamCookies") {
    (async () => {
      const get = (name) =>
        chrome.cookies
          .get({ url: "https://steamcommunity.com", name })
          .then((c) => (c ? c.value : null))
          .catch(() => null);
      const [sessionid, login] = await Promise.all([
        get("sessionid"),
        get("steamLoginSecure"),
      ]);
      sendResponse({ sessionid, login });
    })();
    return true; // 异步响应
  }
  return false;
});
