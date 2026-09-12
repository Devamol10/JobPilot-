import { chromium } from "playwright";
import { isGenuineBlock } from "./browser_runner";

export type CanaryStatus = "HEALTHY" | "BLOCKED" | "UNKNOWN";

class CanaryHealthMonitor {
  private status: CanaryStatus = "UNKNOWN";
  private lastCheckTime: string | null = null;
  private lastCheckMs: number = 0;
  private timer: NodeJS.Timeout | null = null;

  public async runCheck(): Promise<{ status: CanaryStatus; statusCode?: number; title?: string }> {
    console.log("[Canary Health] Running background ping check on naukri.com...");
    let browser = null;
    let page = null;
    let currentStatus: CanaryStatus = "UNKNOWN";
    let statusCode: number | undefined;
    let title: string = "";

    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      });
      page = await context.newPage();

      const res = await page.goto("https://www.naukri.com/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
      statusCode = res?.status();
      await page.waitForTimeout(2000);

      const isBlocked = await isGenuineBlock(page, statusCode);
      title = await page.title().catch(() => "");
      currentStatus = isBlocked ? "BLOCKED" : "HEALTHY";

      console.log(`[Canary Health] Check complete: Status = ${currentStatus} (Title: "${title}", HTTP: ${statusCode ?? "N/A"})`);
    } catch (err: any) {
      console.error("[Canary Health ERROR] Ping check failed:", err.message);
      currentStatus = "BLOCKED";
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    const previousStatus = this.status;
    this.status = currentStatus;
    this.lastCheckTime = new Date().toISOString();
    this.lastCheckMs = Date.now();

    // Trigger webhook on status change
    if (previousStatus !== "UNKNOWN" && previousStatus !== currentStatus) {
      await this.sendWebhookNotification(previousStatus, currentStatus, title, statusCode);
    }

    return { status: currentStatus, statusCode, title };
  }

  private async sendWebhookNotification(
    oldStatus: CanaryStatus,
    newStatus: CanaryStatus,
    title: string,
    statusCode?: number
  ) {
    let targetUrl = process.env.WEBHOOK_URL;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!targetUrl && botToken && chatId) {
      targetUrl = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}`;
    }

    if (!targetUrl) {
      console.log("[Canary Health] Neither WEBHOOK_URL nor TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID configured. Skipping alert notification.");
      return;
    }

    console.log(`[Canary Health] Sending Alert Notification: ${oldStatus} -> ${newStatus}`);

    const isBlock = newStatus === "BLOCKED";
    const isTelegram = targetUrl.includes("api.telegram.org");

    let payload: any;
    if (isTelegram) {
      const textMsg = isBlock
        ? `⚠️ *[JobPilot Canary Alert]*\n*IP Block Detected on naukri.com!*\n\n• Previous State: ${oldStatus}\n• New State: ${newStatus}\n• HTTP Status: ${statusCode ?? "N/A"}\n• Page Title: ${title || "N/A"}`
        : `🎉 *[JobPilot Canary Alert]*\n*IP Block Cleared on naukri.com!*\n\n• Previous State: ${oldStatus}\n• New State: ${newStatus}\n• HTTP Status: ${statusCode ?? "N/A"}\n• Page Title: ${title || "N/A"}`;
      
      payload = {
        text: textMsg,
        parse_mode: "Markdown",
      };

      if (chatId) {
        payload.chat_id = chatId;
      }
    } else {
      payload = {
        content: isBlock
          ? `⚠️ **[JobPilot Canary Alert] IP Block Detected on naukri.com!**`
          : `✅ **[JobPilot Canary Alert] IP Block Cleared on naukri.com!**`,
        embeds: [
          {
            title: isBlock ? "🚫 naukri.com Access Blocked" : "🎉 naukri.com Access Restored",
            color: isBlock ? 0xef4444 : 0x22c55e,
            fields: [
              { name: "Previous State", value: oldStatus, inline: true },
              { name: "New State", value: newStatus, inline: true },
              { name: "HTTP Status", value: String(statusCode ?? "N/A"), inline: true },
              { name: "Page Title", value: title || "N/A" },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    try {
      await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log("[Canary Health] Webhook/Telegram alert sent successfully.");
    } catch (err: any) {
      console.error("[Canary Health ERROR] Failed to send alert:", err.message);
    }
  }

  public start(intervalMinutes: number = 12) {
    if (this.timer) clearInterval(this.timer);
    console.log(`[Canary Health] Starting background monitor (interval: ${intervalMinutes} mins)...`);
    
    // Run initial check after 10s warmup delay
    setTimeout(() => {
      this.runCheck().catch(() => {});
    }, 10000);

    this.timer = setInterval(() => {
      this.runCheck().catch(() => {});
    }, intervalMinutes * 60 * 1000);
  }

  public stop() {
    if (this.timer) clearInterval(this.timer);
  }

  public getStatusInfo() {
    return {
      status: this.status,
      lastCheckTime: this.lastCheckTime,
      lastCheckAgeMinutes: this.lastCheckMs ? Math.floor((Date.now() - this.lastCheckMs) / 60000) : null,
      webhookConfigured: Boolean(process.env.WEBHOOK_URL),
    };
  }
}

export const canaryMonitor = new CanaryHealthMonitor();
