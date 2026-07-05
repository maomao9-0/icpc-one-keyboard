const { test, expect } = require("@playwright/test");

async function createSession(page, name = "Alice") {
  await page.goto("/");
  await page.locator('input[name="name"]').fill(name);
  await page.getByRole("button", { name: "Create Session" }).click();
  await expect(page.getByRole("button", { name: "Claim keyboard" })).toBeVisible();
  return page.locator(".code").innerText();
}

async function sessionPost(page, body) {
  const res = await page.request.post("/api/session", { data: body });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function sessionGet(page, params) {
  const res = await page.request.get(`/api/session?${new URLSearchParams(params)}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function expectBadPost(page, body, message) {
  const res = await page.request.post("/api/session", { data: body });
  expect(res.ok()).toBeFalsy();
  const data = await res.json();
  expect(data.error).toContain(message);
}

function eventByMessage(session, fragment) {
  return session.events.find((event) => event.message.includes(fragment));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockNotifications(page) {
  await page.addInitScript(() => {
    window.__notifications = [];
    class MockNotification {
      static permission = "granted";
      static requestPermission() {
        return Promise.resolve("granted");
      }
      constructor(title, options = {}) {
        window.__notifications.push({ title, body: options.body || "" });
      }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: MockNotification });
  });
}

async function trackSessionPolls(page) {
  await page.addInitScript(() => {
    window.__sessionPolls = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      const request = args[0];
      const url = typeof request === "string" ? request : request?.url || "";
      if (url.includes("/api/session?")) window.__sessionPolls += 1;
      return nativeFetch(...args);
    };
  });
}

function parseClock(text) {
  const [hours, minutes, seconds] = String(text).split(":").map(Number);
  return (hours * 3600) + (minutes * 60) + seconds;
}

test("homepage inputs keep focus and accept typing", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[name="name"]').click();
  await page.keyboard.type("Alice");
  await page.locator('input[name="code"]').click();
  await page.keyboard.type("ABC123");
  await expect(page.locator('input[name="name"]')).toHaveValue("Alice");
  await expect(page.locator('input[name="code"]')).toHaveValue("ABC123");
  await expect(page.locator('input[name="code"]')).toBeFocused();
});

test("creating a session stays on the session screen after polling", async ({ page }) => {
  await createSession(page);
  await page.waitForTimeout(2500);
  await expect(page.getByRole("button", { name: "Claim keyboard" })).toBeVisible();
  await expect(page.locator(".holder")).toHaveText("Unused");
});

test("polling does not replace the header while the timer is ticking", async ({ page }) => {
  await createSession(page);
  await page.getByRole("button", { name: "Start timer" }).click();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();

  await page.evaluate(() => {
    window.__topbarNode = document.querySelector(".topbar");
    window.__brandNode = document.querySelector(".brand");
  });

  await page.waitForTimeout(1200);

  const stable = await page.evaluate(() => ({
    sameTopbar: window.__topbarNode === document.querySelector(".topbar"),
    sameBrand: window.__brandNode === document.querySelector(".brand"),
  }));
  expect(stable.sameTopbar).toBe(true);
  expect(stable.sameBrand).toBe(true);
});

test("contest timer changes on second boundaries and freezes while paused", async ({ page }) => {
  await createSession(page);
  const initial = await page.locator("[data-timer]").innerText();

  await page.getByRole("button", { name: "Start timer" }).click();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();

  await page.waitForTimeout(1200);
  const first = await page.locator("[data-timer]").innerText();
  await page.waitForTimeout(1100);
  const second = await page.locator("[data-timer]").innerText();

  expect(parseClock(first)).toBeLessThan(parseClock(initial));
  expect(parseClock(second)).toBeLessThan(parseClock(first));

  await page.getByRole("button", { name: "Stop timer" }).click();
  const paused = await page.locator("[data-timer]").innerText();
  await page.waitForTimeout(1700);
  await expect(page.locator("[data-timer]")).toHaveText(paused);
});

test("expanded last action stays open across polling and countdown updates", async ({ page }) => {
  await createSession(page);
  await page.getByRole("button", { name: "Start timer" }).click();
  await page.getByRole("button", { name: "Claim keyboard" }).click();
  await page.locator("[data-audit-log] summary").click();
  await expect(page.locator("[data-audit-log]")).toHaveAttribute("open", "");

  await page.evaluate(() => {
    window.__auditNode = document.querySelector("[data-audit-log]");
  });

  await page.waitForTimeout(2200);

  const stable = await page.evaluate(() => ({
    sameAuditNode: window.__auditNode === document.querySelector("[data-audit-log]"),
    open: document.querySelector("[data-audit-log]")?.open ?? false,
  }));
  expect(stable.sameAuditNode).toBe(true);
  expect(stable.open).toBe(true);
  await expect(page.locator(".scroll-log")).toContainText("claimed the keyboard");
});

test("claim and release update the status and audit log", async ({ page }) => {
  await createSession(page);
  await page.getByRole("button", { name: "Add note…" }).click();
  await page.getByLabel("Optional claim note").fill("Taking over input parsing");
  await page.getByRole("button", { name: "Claim keyboard" }).click();
  await expect(page.locator(".holder")).toHaveText("Alice");
  await expect(page.getByRole("button", { name: "Release keyboard" })).toBeVisible();
  await expect(page.locator("[data-audit-log] summary")).toContainText('Alice claimed the keyboard: "Taking over input parsing"');
  await page.getByRole("button", { name: "Add note…" }).click();
  await page.getByLabel("Optional release note").fill("Handing off after fixing the parser");
  await page.getByRole("button", { name: "Release keyboard" }).click();
  await expect(page.locator(".holder")).toHaveText("Unused");
  await page.locator("[data-audit-log] summary").click();
  await expect(page.locator(".log")).toContainText('released the keyboard: "Handing off after fixing the parser"');
});

test("leaving a session returns the tab to the home page", async ({ page }) => {
  await createSession(page);
  await page.locator(".member.self").getByRole("button", { name: "Leave" }).click();
  await expect(page.getByRole("dialog", { name: "Leave session" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await page.getByRole("dialog", { name: "Leave session" }).getByRole("button", { name: "Leave session" }).click();
  await expect(page.getByRole("button", { name: "Create Session" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Join Session" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Claim keyboard" })).toHaveCount(0);
  await expect(page.locator('input[name="code"]')).toHaveValue("");
  await expect(page).toHaveURL(/\/$/);
});

test("two teammates see claims and requests through polling", async ({ browser }) => {
  const aliceContext = await browser.newContext({ permissions: ["notifications"] });
  const bobContext = await browser.newContext({ permissions: ["notifications"] });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  const code = await createSession(alice, "Alice");
  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Bob");
  await bob.getByRole("button", { name: "Join Session" }).click();
  await expect(bob.getByRole("button", { name: "Claim keyboard" })).toBeVisible();

  await alice.getByRole("button", { name: "Claim keyboard" }).click();
  await expect(bob.locator(".holder")).toHaveText("Alice", { timeout: 5000 });
  await bob.getByRole("button", { name: "Request keyboard" }).click();
  await expect(alice.locator("[data-audit-log] summary")).toContainText("Bob requested the keyboard", { timeout: 5000 });

  await aliceContext.close();
  await bobContext.close();
});

test("join rejects a duplicate teammate name", async ({ browser, page }) => {
  const code = await createSession(page, "Alice");
  const bob = await browser.newPage();

  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Alice");
  await bob.getByRole("button", { name: "Join Session" }).click();

  await expect(bob.locator(".toast")).toContainText('Error: A teammate named "Alice" is already in this session');
  await expect(bob.getByRole("button", { name: "Join Session" })).toBeVisible();
  await expect(page.locator(".members")).toContainText("Alice");

  await bob.close();
});

test("requesting from a holder notifies the holder and does not steal the keyboard", async ({ browser }) => {
  const aliceContext = await browser.newContext({ permissions: ["notifications"] });
  const bobContext = await browser.newContext({ permissions: ["notifications"] });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await mockNotifications(alice);

  const code = await createSession(alice, "Alice");
  await alice.getByRole("button", { name: "Claim keyboard" }).click();
  await expect(alice.locator(".holder")).toHaveText("Alice");

  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Bob");
  await bob.getByRole("button", { name: "Join Session" }).click();
  await expect(bob.getByRole("button", { name: "Request keyboard" })).toBeVisible();
  await alice.evaluate(() => {
    window.__notifications = [];
  });

  await bob.getByRole("button", { name: "Add note…" }).click();
  await bob.getByLabel("Optional request note").fill("Need to test the fix on problem C");
  await bob.getByRole("button", { name: "Request keyboard" }).click();
  await expect(alice.locator("[data-audit-log] summary")).toContainText('Bob requested the keyboard: "Need to test the fix on problem C"', { timeout: 5000 });
  await expect(alice.locator(".holder")).toHaveText("Alice");
  await expect(bob.locator(".holder")).toHaveText("Alice");
  await expect(alice.locator(".request-note")).toContainText("Need to test the fix on problem C");
  await expect.poll(() => alice.evaluate(() => window.__notifications.map((item) => item.body))).toContain('Bob requested the keyboard: "Need to test the fix on problem C"');

  await aliceContext.close();
  await bobContext.close();
});

test("holder can release keyboard to requester from popup", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  const code = await createSession(alice, "Alice");
  await alice.getByRole("button", { name: "Claim keyboard" }).click();
  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Bob");
  await bob.getByRole("button", { name: "Join Session" }).click();
  await bob.getByRole("button", { name: "Add note…" }).click();
  await bob.getByLabel("Optional request note").fill("Ready to drive the next submission");
  await bob.getByRole("button", { name: "Request keyboard" }).click();

  await expect(alice.locator(".request-note")).toContainText("Ready to drive the next submission");
  await alice.getByRole("button", { name: "Release to Bob" }).click();
  await expect(alice.locator(".holder")).toHaveText("Bob");
  await expect(bob.locator(".holder")).toHaveText("Bob", { timeout: 5000 });
  await expect(bob.getByRole("button", { name: "Release keyboard" })).toBeVisible();

  await aliceContext.close();
  await bobContext.close();
});

test("holder can reject requester popup and timeout auto-rejects", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  const code = await createSession(alice, "Alice");
  await alice.getByRole("button", { name: "Claim keyboard" }).click();
  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Bob");
  await bob.getByRole("button", { name: "Join Session" }).click();
  await expect(bob.locator(".holder")).toHaveText("Alice", { timeout: 5000 });
  await expect(bob.getByRole("button", { name: "Request keyboard" })).toBeVisible({ timeout: 5000 });

  await bob.getByRole("button", { name: "Request keyboard" }).click();
  await expect(alice.getByRole("dialog", { name: "Keyboard request" })).toBeVisible({ timeout: 5000 });
  await alice.getByRole("button", { name: "Reject" }).click();
  await expect(alice.getByRole("dialog", { name: "Keyboard request" })).toHaveCount(0);
  await expect(alice.locator(".holder")).toHaveText("Alice");

  await bob.getByRole("button", { name: "Request keyboard" }).click();
  await expect(alice.getByRole("dialog", { name: "Keyboard request" })).toBeVisible({ timeout: 5000 });
  await expect(alice.getByText("Auto-rejects in")).toBeVisible();
  await expect(alice.getByRole("dialog", { name: "Keyboard request" })).toHaveCount(0, { timeout: 13000 });
  await expect(alice.locator(".holder")).toHaveText("Alice");

  await aliceContext.close();
  await bobContext.close();
});

test("request countdown stays stable and refreshes once when it reaches zero", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await trackSessionPolls(alice);

  const code = await createSession(alice, "Alice");
  await alice.getByRole("button", { name: "Claim keyboard" }).click();

  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Bob");
  await bob.getByRole("button", { name: "Join Session" }).click();
  await expect(bob.getByRole("button", { name: "Request keyboard" })).toBeVisible({ timeout: 5000 });
  await bob.getByRole("button", { name: "Request keyboard" }).click();

  const aliceClientId = await alice.evaluate(() => localStorage.getItem("clientId"));
  await expect.poll(async () => {
    const session = await sessionGet(alice, { code, clientId: aliceClientId, name: "Alice" });
    return session.session.pendingRequest?.name || "";
  }).toBe("Bob");

  const dialog = alice.getByRole("dialog", { name: "Keyboard request" });
  const countdown = alice.locator("[data-request-countdown]");
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(countdown).not.toHaveText("0");
  const initial = Number(await countdown.innerText());

  await alice.evaluate(() => {
    window.__requestDialog = document.querySelector(".request-pop");
  });

  await alice.waitForTimeout(2200);
  const midCount = Number(await countdown.innerText());
  const sameDialog = await alice.evaluate(() => window.__requestDialog === document.querySelector(".request-pop"));
  expect(midCount).toBeLessThan(initial);
  expect(sameDialog).toBe(true);

  await expect(countdown).toHaveText("1", { timeout: 11000 });
  const pollsBeforeExpiry = await alice.evaluate(() => window.__sessionPolls);
  await expect(dialog).toHaveCount(0, { timeout: 3000 });
  await alice.waitForTimeout(900);
  const pollsAfter = await alice.evaluate(() => window.__sessionPolls);
  const stillRemoved = await alice.evaluate(() => window.__requestDialog === document.querySelector(".request-pop"));

  expect(pollsAfter - pollsBeforeExpiry).toBeLessThanOrEqual(3);
  expect(stillRemoved).toBe(false);
  expect(initial).toBeGreaterThan(0);

  await aliceContext.close();
  await bobContext.close();
});

test("three users cannot concurrently claim or release another holder", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const charlieContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const charlie = await charlieContext.newPage();

  const code = await createSession(alice, "Alice");
  await alice.getByRole("button", { name: "Claim keyboard" }).click();
  await expect(alice.locator(".holder")).toHaveText("Alice");

  for (const [page, name] of [[bob, "Bob"], [charlie, "Charlie"]]) {
    await page.goto(`/?code=${code}`);
    await page.locator('input[name="name"]').fill(name);
    await page.getByRole("button", { name: "Join Session" }).click();
    await expect(page.getByRole("button", { name: "Request keyboard" })).toBeVisible();
    await expect(page.locator(".holder")).toHaveText("Alice");
  }

  await expectBadPost(bob, { action: "claim", code, clientId: "bob-api", name: "Bob" }, "Alice is already using the keyboard");
  await expectBadPost(charlie, { action: "release", code, clientId: "charlie-api", name: "Charlie" }, "Only the holder can release");
  await expect(alice.locator(".holder")).toHaveText("Alice");

  await alice.getByRole("button", { name: "Release keyboard" }).click();
  await expect(bob.getByRole("button", { name: "Claim keyboard" })).toBeVisible({ timeout: 5000 });
  await bob.getByRole("button", { name: "Claim keyboard" }).click();
  await expect(alice.locator(".holder")).toHaveText("Bob", { timeout: 5000 });
  await expect(charlie.locator(".holder")).toHaveText("Bob", { timeout: 5000 });

  await aliceContext.close();
  await bobContext.close();
  await charlieContext.close();
});

test("leave action removes the teammate and force releases the keyboard", async ({ page }) => {
  const created = await sessionPost(page, { action: "create", clientId: "owner", name: "Owner", durationMs: 5 * 60 * 60 * 1000 });
  const code = created.code;
  await sessionPost(page, { action: "claim", code, clientId: "owner", name: "Owner" });
  await sessionPost(page, { action: "join", code, clientId: "guest", name: "Guest" });

  const left = await sessionPost(page, { action: "leave", code, clientId: "owner", name: "Owner" });
  expect(left.session.holder).toBeNull();
  expect(left.session.members.owner).toBeUndefined();
  expect(left.session.members.guest.name).toBe("Guest");
  expect(left.session.events.at(-1).message).toContain("left and released the keyboard");
});

test("last member leaving deletes the session", async ({ page }) => {
  const created = await sessionPost(page, { action: "create", clientId: "owner", name: "Owner", durationMs: 5 * 60 * 60 * 1000 });
  const code = created.code;

  const left = await sessionPost(page, { action: "leave", code, clientId: "owner", name: "Owner" });
  expect(left.deleted).toBe(true);
  const lookup = await page.request.get(`/api/session?${new URLSearchParams({ code, clientId: "owner", name: "Owner" })}`);
  expect(lookup.ok()).toBeFalsy();
  expect(lookup.status()).toBe(404);
});

test("leaving from teammates removes the member for everyone else", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const bob = await bobContext.newPage();

  const code = await createSession(owner, "Owner");
  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Bob");
  await bob.getByRole("button", { name: "Join Session" }).click();
  await expect(owner.locator(".members")).toContainText("Bob", { timeout: 5000 });

  await bob.locator(".member.self").getByRole("button", { name: "Leave" }).click();
  await bob.getByRole("dialog", { name: "Leave session" }).getByRole("button", { name: "Leave session" }).click();
  await expect(bob.getByRole("button", { name: "Create Session" })).toBeVisible();
  await expect(owner.locator(".members")).not.toContainText("Bob", { timeout: 5000 });
  await expect(owner.locator(".members")).toContainText("Owner");

  await ownerContext.close();
  await bobContext.close();
});

test("closing while only the countdown is running still asks for confirmation", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await createSession(page, "Timer Owner");
  await page.getByRole("button", { name: "Start timer" }).click();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();

  const dialogPromise = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
  await expect.poll(() => page.isClosed()).toBe(true);
});

test("closing an active page asks for confirmation and removes the holder from the session", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  const code = await createSession(alice, "Alice");
  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Bob");
  await bob.getByRole("button", { name: "Join Session" }).click();
  await expect(bob.getByRole("button", { name: "Claim keyboard" })).toBeVisible();

  await alice.getByRole("button", { name: "Claim keyboard" }).click();
  await alice.getByRole("button", { name: "Start timer" }).click();
  await expect(alice.getByRole("button", { name: "Stop timer" })).toBeVisible();

  const dialogPromise = alice.waitForEvent("dialog");
  await alice.close({ runBeforeUnload: true });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
  await expect.poll(() => alice.isClosed()).toBe(true);

  await expect(bob.locator(".holder")).toHaveText("Unused", { timeout: 5000 });
  await expect(bob.locator(".members")).not.toContainText("Alice", { timeout: 5000 });

  const session = await sessionGet(bob, { code, clientId: "bob-check", name: "Bob" });
  expect(session.session.holder).toBeNull();
  expect(Object.values(session.session.members).map((member) => member.name)).not.toContain("Alice");
  expect(session.session.events.at(-1).message).toContain("left and released the keyboard");

  await bobContext.close();
});

test("timer settings do not steal focus while countdown updates", async ({ page }) => {
  await createSession(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator('input[name="hours"]').fill("5");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator("[data-timer]")).toHaveText("5:00:00");
  await page.getByRole("button", { name: "Start timer" }).click();
  await expect(page.locator("[data-timer]")).not.toHaveText("--:--:--");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator('input[name="name"]').click();
  await page.evaluate(() => {
    window.__settingsModal = document.querySelector(".modal");
    window.__settingsName = document.querySelector('.settings input[name="name"]');
  });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("Alice Timer");
  await page.waitForTimeout(1800);
  await expect(page.locator('input[name="name"]')).toHaveValue("Alice Timer");
  await expect(page.locator('input[name="name"]')).toBeFocused();
  const stable = await page.evaluate(() => ({
    sameModal: window.__settingsModal === document.querySelector(".modal"),
    sameName: window.__settingsName === document.querySelector('.settings input[name="name"]'),
  }));
  expect(stable.sameModal).toBe(true);
  expect(stable.sameName).toBe(true);
});

test("poll failure does not send the user back to the homepage", async ({ page }) => {
  await createSession(page);
  await page.route("**/api/session?code=*", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Session not found"}' });
    } else {
      route.continue();
    }
  });
  await page.waitForTimeout(1800);
  await expect(page.getByRole("button", { name: "Claim keyboard" })).toBeVisible();
  await expect(page.locator(".error")).toContainText("Sync issue");
});

test("claim still works after a transient poll failure", async ({ page }) => {
  await createSession(page);
  let failPolls = true;
  await page.route("**/api/session?code=*", (route) => {
    if (failPolls && route.request().method() === "GET") {
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Temporary sync failure"}' });
    } else {
      route.continue();
    }
  });
  await page.waitForTimeout(1800);
  await expect(page.locator(".error")).toContainText("Sync issue");

  await page.getByRole("button", { name: "Claim keyboard" }).click();
  await expect(page.locator(".holder")).toHaveText("Alice");
  await expect(page.getByRole("button", { name: "Release keyboard" })).toBeVisible();
  failPolls = false;
  await expect(page.locator(".error")).toHaveCount(0);

  await expect(page.locator("[data-audit-log] summary")).toContainText("Alice claimed the keyboard", { timeout: 5000 });
});

test("direct join link pre-fills the code and lets a teammate join", async ({ page, browser }) => {
  const owner = await browser.newPage();
  const code = await createSession(owner, "Owner");

  await page.goto(`/?code=${code}`);
  await expect(page.locator('input[name="code"]')).toHaveValue(code);
  await page.locator('input[name="name"]').fill("Charlie");
  await page.getByRole("button", { name: "Join Session" }).click();
  await expect(page.getByRole("button", { name: "Claim keyboard" })).toBeVisible();
  await expect(page.locator(".code")).toHaveText(code);
  await expect(page.locator(".error")).toHaveCount(0);

  await owner.close();
});

test("settings save updates name and timer without stale sync warnings", async ({ page }) => {
  await createSession(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator('.settings input[name="name"]').fill("Alice Updated");
  await page.locator('input[name="hours"]').fill("4");
  await page.locator('input[name="minutes"]').fill("30");
  await page.locator('input[name="seconds"]').fill("15");
  await page.getByRole("button", { name: "Save settings" }).click();

  await expect(page.getByText("Signed in as Alice Updated")).toBeVisible();
  await expect(page.locator("[data-timer]")).toHaveText("4:30:15");
  await expect(page.locator(".error")).toHaveCount(0);
});

test("settings copy buttons write session code and join link to clipboard", async ({ page }) => {
  const code = await createSession(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Copy Code" }).click();
  await expect(page.locator(".toast")).toContainText("Code copied.");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await page.getByRole("button", { name: "Copy Link" }).click();
  await expect(page.locator(".toast")).toContainText("Link copied.");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`?code=${code}`);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 5000 });
});

test("settings cog opens and close button closes the modal", async ({ page }) => {
  await createSession(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".icon svg")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
});

test("teammate list stays compact and shows active members", async ({ browser }) => {
  const owner = await browser.newPage();
  const bob = await browser.newPage();
  const charlie = await browser.newPage();
  const code = await createSession(owner, "Owner");

  for (const [page, name] of [[bob, "Bob"], [charlie, "Charlie"]]) {
    await page.goto(`/?code=${code}`);
    await page.locator('input[name="name"]').fill(name);
    await page.getByRole("button", { name: "Join Session" }).click();
    await expect(page.getByRole("button", { name: "Claim keyboard" })).toBeVisible();
  }

  await expect(owner.locator(".members")).toContainText("Owner", { timeout: 5000 });
  await expect(owner.locator(".members")).toContainText("Bob");
  await expect(owner.locator(".members")).toContainText("Charlie");
  const metrics = await owner.locator(".members").evaluate((el) => ({
    maxHeight: getComputedStyle(el).maxHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(metrics.maxHeight).toBe("108px");
  expect(metrics.overflowY).toBe("auto");
});

test("member presence badges move from online to idle without replacing the badge", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const bob = await bobContext.newPage();

  const code = await createSession(owner, "Owner");
  await bob.route("**/api/session?code=*", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Temporary sync failure"}' });
      return;
    }
    route.continue();
  });
  await bob.goto(`/?code=${code}`);
  await bob.locator('input[name="name"]').fill("Bob");
  await bob.getByRole("button", { name: "Join Session" }).click();
  const bobClientId = await bob.evaluate(() => localStorage.getItem("clientId"));
  const bobBadge = owner.locator(`[data-member-status="${bobClientId}"]`);

  await expect(bobBadge).toHaveText("online", { timeout: 5000 });
  await owner.evaluate((clientId) => {
    window.__bobBadge = document.querySelector(`[data-member-status="${clientId}"]`);
  }, bobClientId);

  await owner.waitForTimeout(12500);
  await expect(bobBadge).toHaveText("idle", { timeout: 3000 });
  const stable = await owner.evaluate((clientId) => window.__bobBadge === document.querySelector(`[data-member-status="${clientId}"]`), bobClientId);
  expect(stable).toBe(true);

  await ownerContext.close();
  await bobContext.close();
});

test("timer start stop and reset control remaining time", async ({ page }) => {
  await createSession(page);
  await expect(page.locator("[data-timer]")).toHaveText("5:00:00");
  await page.getByRole("button", { name: "Start timer" }).click();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();
  await page.waitForTimeout(1700);
  await expect(page.locator("[data-timer]")).not.toHaveText("5:00:00");
  await page.getByRole("button", { name: "Stop timer" }).click();
  await expect(page.getByRole("button", { name: "Start timer" })).toBeVisible();
  const stopped = await page.locator("[data-timer]").innerText();
  await page.waitForTimeout(1700);
  await expect(page.locator("[data-timer]")).toHaveText(stopped);
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator("[data-timer]")).toHaveText("5:00:00");
  await expect(page.getByRole("button", { name: "Start timer" })).toBeVisible();
});

test("timer audit timestamps become contest-relative only after start", async ({ page }) => {
  await createSession(page);
  await page.locator("[data-audit-log] summary").click();
  await expect(page.locator(".log-row").first()).not.toContainText("T+");
  await page.locator("[data-audit-log] summary").click();

  await page.getByRole("button", { name: "Start timer" }).click();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();
  await page.getByRole("button", { name: "Claim keyboard" }).click();
  await page.locator("[data-audit-log] summary").click();
  await expect(page.locator(".log-row").first()).toContainText("T+");
});

test("pause freezes contest elapsed time and resume restarts from the same audit timestamp", async ({ page }) => {
  const created = await sessionPost(page, { action: "create", clientId: "owner", name: "Alice", durationMs: 5 * 60 * 60 * 1000 });
  const code = created.code;
  await sessionPost(page, { action: "timer", command: "start", code, clientId: "owner", name: "Alice" });
  await sleep(1200);
  const stopped = await sessionPost(page, { action: "timer", command: "stop", code, clientId: "owner", name: "Alice" });
  const stopEvent = stopped.session.events.at(-1);
  expect(stopEvent.message).toContain("stopped the timer");
  expect(stopEvent.timestampMode).toBe("relative");

  await sleep(1200);
  const resumed = await sessionPost(page, { action: "timer", command: "start", code, clientId: "owner", name: "Alice" });
  const resumeEvent = resumed.session.events.at(-1);
  expect(resumeEvent.message).toContain("started the timer");
  expect(resumeEvent.timestampMode).toBe("relative");
  expect(resumeEvent.clockMs).toBe(stopEvent.clockMs);

  await sleep(1100);
  const joined = await sessionPost(page, { action: "join", code, clientId: "bob-resume", name: "Bob Resume" });
  const joinEvent = joined.session.events.at(-1);
  expect(joinEvent.timestampMode).toBe("relative");
  expect(joinEvent.clockMs).toBeGreaterThan(resumeEvent.clockMs);
});

test("audit rows keep their original local or relative labels across start reset and restart", async ({ page }) => {
  const code = await createSession(page);
  const claimed = await sessionPost(page, { action: "claim", code, clientId: "owner", name: "Alice" });
  expect(eventByMessage(claimed.session, "claimed the keyboard").timestampMode).toBe("local");

  await sessionPost(page, { action: "timer", command: "start", code, clientId: "owner", name: "Alice" });
  await sleep(1400);
  const firstRelative = await sessionPost(page, { action: "join", code, clientId: "bob-cycle", name: "Bob Cycle" });
  const bobEvent = eventByMessage(firstRelative.session, "Bob Cycle joined");
  expect(bobEvent.timestampMode).toBe("relative");

  await sessionPost(page, { action: "timer", command: "reset", code, clientId: "owner", name: "Alice" });
  const localAfterReset = await sessionPost(page, { action: "join", code, clientId: "charlie-cycle", name: "Charlie Cycle" });
  const charlieEvent = eventByMessage(localAfterReset.session, "Charlie Cycle joined");
  expect(charlieEvent.timestampMode).toBe("local");

  await sessionPost(page, { action: "timer", command: "start", code, clientId: "owner", name: "Alice" });
  await sleep(1400);
  const secondRelative = await sessionPost(page, { action: "join", code, clientId: "dana-cycle", name: "Dana Cycle" });
  const danaEvent = eventByMessage(secondRelative.session, "Dana Cycle joined");
  expect(danaEvent.timestampMode).toBe("relative");
  expect(danaEvent.clockMs).toBeLessThan(bobEvent.clockMs + 1000);

  await page.waitForTimeout(1800);
  await page.locator("[data-audit-log] summary").click();

  const bobRow = page.locator(".log-row").filter({ hasText: "Bob Cycle joined" }).first();
  const charlieRow = page.locator(".log-row").filter({ hasText: "Charlie Cycle joined" }).first();
  const danaRow = page.locator(".log-row").filter({ hasText: "Dana Cycle joined" }).first();

  await expect(bobRow).toContainText("T+");
  await expect(charlieRow).not.toContainText("T+");
  await expect(danaRow).toContainText("T+");
});

test("api stores optional notes on claim request and release events", async ({ page }) => {
  const created = await sessionPost(page, { action: "create", clientId: "owner", name: "Alice", durationMs: 5 * 60 * 60 * 1000 });
  const code = created.code;

  const claimed = await sessionPost(page, { action: "claim", code, clientId: "owner", name: "Alice", note: "Taking over editor navigation" });
  expect(eventByMessage(claimed.session, "claimed the keyboard").message).toContain('Alice claimed the keyboard: "Taking over editor navigation"');

  await sessionPost(page, { action: "join", code, clientId: "bob", name: "Bob" });
  const requested = await sessionPost(page, { action: "request", code, clientId: "bob", name: "Bob", note: "Need the keyboard for the final submit" });
  expect(requested.session.pendingRequest.note).toBe("Need the keyboard for the final submit");
  expect(eventByMessage(requested.session, "requested the keyboard").message).toContain('Bob requested the keyboard: "Need the keyboard for the final submit"');

  const released = await sessionPost(page, { action: "release", code, clientId: "owner", name: "Alice", note: "Done with the handoff" });
  expect(eventByMessage(released.session, "released the keyboard").message).toContain('Alice released the keyboard: "Done with the handoff"');
});

test("expanded audit log scrolls within its card", async ({ page }) => {
  const code = await createSession(page);
  for (let i = 0; i < 18; i += 1) {
    await sessionPost(page, { action: "join", code, clientId: `bot-${i}`, name: `Bot ${i}` });
  }
  await page.waitForTimeout(1800);
  await page.locator("[data-audit-log] summary").click();
  await expect(page.locator(".log-row")).toHaveCount(19);
  const metrics = await page.locator(".scroll-log").evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(metrics.clientHeight).toBeLessThan(metrics.scrollHeight);
  expect(metrics.overflowY).toBe("auto");
});

test("invalid join code reports an error and keeps form usable", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[name="name"]').fill("Dana");
  await page.locator('input[name="code"]').fill("BAD999");
  await page.getByRole("button", { name: "Join Session" }).click();
  await expect(page.locator(".toast")).toContainText("Session not found");
  await expect(page.locator('input[name="code"]')).toHaveValue("BAD999");
  await page.locator('input[name="code"]').fill("ABC123");
  await expect(page.locator('input[name="code"]')).toHaveValue("ABC123");
});

test("api validation covers invalid codes actions users and duration clamping", async ({ page }) => {
  await expectBadPost(page, { action: "join", code: "BAD", clientId: "x", name: "X" }, "Invalid session code");
  await expectBadPost(page, { action: "create", clientId: "", name: "X" }, "Missing client id");
  await expectBadPost(page, { action: "create", clientId: "x", name: "" }, "Missing name");

  const created = await sessionPost(page, { action: "create", clientId: "owner", name: "Owner", durationMs: 1 });
  const code = created.code;
  expect(created.session.durationMs).toBe(15 * 60 * 1000);
  await expectBadPost(page, { action: "nope", code, clientId: "owner", name: "Owner" }, "Unknown action");
  await expectBadPost(page, { action: "timer", command: "warp", code, clientId: "owner", name: "Owner" }, "Unknown timer command");

  const updated = await sessionPost(page, {
    action: "settings",
    code,
    clientId: "owner",
    name: "Owner",
    durationMs: 99 * 60 * 60 * 1000,
    timerEnabled: true,
  });
  expect(updated.session.durationMs).toBe(24 * 60 * 60 * 1000);
});
