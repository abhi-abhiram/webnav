(() => {
  // Read-only, versioned code. No generated CSS classes or message instructions.
  const visible = el => !!el.getClientRects().length;
  const channels = new Map();
  let selectedChannelID = "";
  for (const a of document.querySelectorAll('a[href^="/channels/"]')) {
    if (!visible(a)) continue;
    const match = new URL(a.href).pathname.match(/^\/channels\/(\d+)\/(\d+)$/);
    if (!match) continue;
    const label = (a.getAttribute("aria-label") || a.innerText || "").trim().slice(0, 256);
    channels.set(match[1] + "/" + match[2], {
      id: match[2], server_id: match[1], name: label,
      url: "https://discord.com" + new URL(a.href).pathname,
      last_observed: ""
    });
    if (a.getAttribute("aria-current") === "page" ||
        a.getAttribute("aria-selected") === "true" ||
        a.closest('[aria-selected="true"]')) {
      selectedChannelID = match[2];
    }
  }
  const heading = [...document.querySelectorAll('main header h1, main header h2, [role="main"] header [role="heading"], [aria-label="Channel header"] h1, [aria-label="Channel header"] h2, [aria-label="Channel header"] [role="heading"]')]
    .find(visible);
  return {
    url: location.href,
    heading: heading ? heading.textContent.trim().slice(0, 256) : "",
    selected_channel_id: selectedChannelID,
    channels: [...channels.values()]
  };
})()
