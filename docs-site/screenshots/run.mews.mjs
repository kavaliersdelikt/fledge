// Render the shipped UI with the same real demo stack and browser WebP encoder as the documentation runner.
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { bootDemo } from "./demo.mjs";
import { seedMews } from "./mews-demo.mjs";
import {captureVM} from "./capture.vm.mjs";
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "../docs/public/screenshots",
);
mkdirSync(out, { recursive: true });
const repo = join(dirname(fileURLToPath(import.meta.url)), "../.."),
  WEB = "http://localhost:3107";
// Build with the isolated API address so this task never needs the user's panel or demo ports.
await new Promise((resolve, reject) => {
  const p = spawn(
    process.execPath,
    [join(repo, "web/node_modules/next/dist/bin/next"), "build"],
    {
      cwd: join(repo, "web"),
      env: { ...process.env, NEXT_PUBLIC_API_URL: "http://localhost:4307" },
      stdio: "inherit",
    },
  );
  p.on("error", reject);
  p.on("exit", (code) =>
    code ? reject(Error("Screenshot build failed")) : resolve(),
  );
});
const demo = await bootDemo({
  db: "fledge_mews_docs_demo",
  apiPort: 4307,
  hostPort: 4597,
  webPort: 3107,
  apiEnv:Object.fromEntries(readFileSync(join(repo,".env.example"),"utf8").split(/\r?\n/).filter(line=>/^USAGE_[A-Z_]+=/.test(line)).map(line=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1)]})),
});
let seeded, browser, page;
try {
  seeded = await seedMews(demo);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 960 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
  });
  page = await context.newPage();
  const failures = [];
  page.on("pageerror", (e) => failures.push(e.message));
  const session = async (c) => {
    await context.clearCookies();
    await context.addCookies([
      {
        name: "fledge_session",
        value: decodeURIComponent(c.cookie.split("=")[1]),
        domain: "localhost",
        path: "/",
      },
    ]);
  };
  const save = async (name, fullPage = false) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (overflow) throw Error(name + ": horizontal overflow");
    await page.evaluate(()=>document.fonts.ready);
    const png = await page.screenshot({ fullPage, animations: "disabled" });
    writeFileSync(join(out, name + ".png"), png);
    const conv = await context.newPage();
    const b64 = await conv.evaluate(async (data) => {
      const blob = await (await fetch("data:image/png;base64," + data)).blob(),
        bmp = await createImageBitmap(blob),
        canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      const out = await canvas.convertToBlob({
          type: "image/webp",
          quality: 0.86,
        }),
        buf = new Uint8Array(await out.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 32768)
        s += String.fromCharCode(...buf.subarray(i, i + 32768));
      return btoa(s);
    }, png.toString("base64"));
    await conv.close();
    writeFileSync(join(out, name + ".webp"), Buffer.from(b64, "base64"));
    console.log("Captured " + name);
  };
  const capture = async (name, path, text, fullPage = false) => {
    await page.goto(WEB + path);
    await page
      .getByText(text, { exact: false })
      .first()
      .waitFor({ timeout: 30000 });
    if (path !== "/abuse") await page.waitForLoadState("networkidle");
    await save(name, fullPage);
  };
  await session(demo.c);
  await capture("team", "/team", "jonas@fledge.demo");
  await page.getByRole("button", { name: /jonas@fledge.demo/ }).click();
  await save("team");
  await capture("desk-queue", "/support", "Queue");
  await capture(
    "desk-ticket",
    "/support/" + seeded.tickets[0].id,
    "Internal note",
  );
  await capture("desk-settings", "/support/settings", "Enable help desk");
  await capture("desk-reports", "/support/reports", "Daily activity");
  await session(seeded.owner);
  await capture("support-home", "/support", "Help centre");
  await capture("support-new", "/support/new", "Your question");
  await capture(
    "support-ticket",
    "/support/" + seeded.tickets[0].id,
    "Your reply",
  );
  await capture(
    "kb-article",
    "/support/articles/server-wont-start",
    "Out of memory",
  );
  await session(seeded.paused);
  await capture("suspended-dark", "/servers", "Your account is paused", true);
  await page
    .getByRole("button", { name: "Billing", exact: true })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "Billing", exact: true })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await seeded.paused.call("PUT", "/api/auth/preferences", { mode: "light" });
  await capture("suspended-light", "/", "Your account is paused", true);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(
    "suspended-mobile",
    "/servers/ignored",
    "Your account is paused",
    true,
  );
  await page.setViewportSize({ width: 1360, height: 960 });
  await session(demo.c);
  await capture("suspension-history", "/customers", seeded.suspended.email);
  await page.getByText(seeded.suspended.email, { exact: true }).first().click();
  await page
    .getByRole("heading", { name: "Account suspension", exact: true })
    .waitFor();
  await page.getByRole("button",{name:"Edit suspension",exact:true}).waitFor();
  await page.waitForLoadState("networkidle");
  await save("suspension-history");
  await page
    .getByRole("button", { name: "Edit suspension", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await save("suspend-dialog");
  // Exercise the shipped forms, including private-note isolation, rather than just loading pages.
  await page
    .getByLabel("Message the customer will read")
    .fill(
      "Your payment is being reviewed. We will update this message shortly.",
    );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Edit suspension", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByText(
      "Your payment is being reviewed. We will update this message shortly.",
      { exact: true },
    )
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Lift suspension", exact: true })
    .click();
  await page.getByText("Restored", { exact: true }).first().waitFor();
  await session(seeded.owner);
  await page.goto(WEB + "/support/new");
  await page
    .getByLabel("Category", { exact: true })
    .selectOption({ label: "Server help" });
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Browser verification question");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Can you check the server settings with me?");
  await page.getByRole("button", { name: "Send ticket", exact: true }).click();
  await page
    .getByRole("heading", { name: /Browser verification question/ })
    .waitFor();
  const ticketPath = new URL(page.url()).pathname;
  await session(demo.c);
  await page.goto(WEB + ticketPath);
  await page
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await page
    .getByLabel(/Internal note.*visible only/)
    .fill("Browser-only private note");
  await page
    .getByRole("button", { name: "Save internal note", exact: true })
    .click();
  await page.getByText("Browser-only private note", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Public reply", exact: true }).click();
  await page
    .getByLabel("Your reply", { exact: true })
    .fill("Please confirm the current view distance.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page
    .getByText("Please confirm the current view distance.", { exact: true })
    .waitFor();
  await session(seeded.owner);
  await page.goto(WEB + ticketPath);
  await page.getByLabel("Your reply", { exact: true }).waitFor();
  if (
    await page.getByText("Browser-only private note", { exact: true }).count()
  )
    throw Error("Private note leaked to customer UI");
  await page
    .getByLabel("Your reply", { exact: true })
    .fill("The view distance is eight chunks.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page
    .getByText("The view distance is eight chunks.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Mark as solved", exact: true })
    .click();
  await page.getByRole("button", { name: "Send rating", exact: true }).click();
  await page
    .getByRole("button", { name: "Send rating", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Reopen ticket", exact: true })
    .click();
  await page.getByLabel("Your reply", { exact: true }).waitFor();
  await session(demo.c);
  await page.goto(WEB + "/support/settings");
  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser rule");
  await page
    .getByLabel("Action 1 message", { exact: true })
    .fill("Created through the real management form.");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByText("Browser rule", { exact: true }).first().waitFor();
  await save("desk-rules", true);
  await page.goto(WEB + "/support/settings");
  await page.getByRole("button", { name: "Inbound", exact: true }).click();
  await page.getByRole("heading", { name: "Inbound email bridge", exact: true }).waitFor();
  await save("desk-inbound", true);
  const mail = demo.c.ok(
    await demo.c.call(
      "POST",
      "/api/email/templates/account_suspended/preview",
      {},
    ),
    "email preview",
  );
  await page.goto("about:blank");
  await page.setContent(mail.html);
  await save("email-suspended", true);
  await context.clearCookies();
  await capture("abuse-form", "/abuse", "What happened?", true);
  const noBot = await fetch(demo.stack.base + "/api/support/abuse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "reporter@example.test",
      address: "localhost:25565",
      category: "spam",
      body: "This report has no bot token.",
    }),
  });
  if (noBot.status !== 400)
    throw Error("Public reports must require a valid bot token");
  // The public form screenshot verifies the shipped UI; successful Turnstile
  // verification is exercised by the API smoke suite, avoiding an external
  // challenge/network dependency in this screenshot workflow.

  await capture("public-help", "/help", "When your Minecraft server", true);
  if (failures.length) throw Error("Browser errors: " + failures.join("; "));
  await session(demo.c);await page.goto(WEB+"/settings#usage");await page.getByRole("heading",{name:"Usage reporting",exact:true}).waitFor();await page.getByRole("checkbox",{name:"I agree to this optional encrypted installation reporting.",exact:true}).waitFor();await page.waitForLoadState("networkidle");await page.locator("#usage").scrollIntoViewIfNeeded();await save("usage-reporting");
  if(process.env.VM_MANIFEST)await captureVM({demo,seeded,page,session,save});
  console.log("Mews browser verification passed");
} catch (error) {
  if (page) {
    console.error("Failure page: " + page.url());
    console.error((await page.locator("body").innerText()).slice(0, 1800));
    await page.screenshot({
      path: join(out, "mews-verification-failure.png"),
      fullPage: true,
    });
  }
  console.error(
    demo.stack.api
      .logs()
      .split("\n")
      .filter((line) => !line.includes("Invalid node credential"))
      .slice(-15)
      .join("\n"),
  );
  throw error;
} finally {
  seeded?.stop();
  await browser?.close();
  await demo.stop();
}
process.exit(process.exitCode || 0);
