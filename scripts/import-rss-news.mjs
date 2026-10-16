import { createClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY GitHub Actions secrets.");
}
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const feeds = [
  { name: "bdnews24.com", url: "https://bdnews24.com/?widgetName=rssfeed&widgetId=1150&getXmlFeed=true", category: "জাতীয়" },
  { name: "The Daily Star", url: "https://www.thedailystar.net/frontpage/rss.xml", category: "জাতীয়" },
  { name: "Jago News 24", url: "https://www.jagonews24.com/rss/rss.xml", category: "জাতীয়" },
  { name: "BBC News বাংলা", url: "https://feeds.bbci.co.uk/bengali/rss.xml", category: "আন্তর্জাতিক" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", category: "আন্তর্জাতিক" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", category: "আন্তর্জাতিক" }
];
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
const clean = (v) => String(v ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const itemsOf = (obj) => {
  const channel = obj?.rss?.channel;
  const rssItems = channel?.item;
  if (rssItems) return Array.isArray(rssItems) ? rssItems : [rssItems];
  const entries = obj?.feed?.entry;
  if (entries) return Array.isArray(entries) ? entries : [entries];
  return [];
};
const linkOf = (item) => {
  if (typeof item.link === "string") return item.link;
  if (Array.isArray(item.link)) {
    const found = item.link.find((x) => x["@_rel"] === "alternate") || item.link[0];
    return found?.["@_href"] || "";
  }
  return item.link?.["@_href"] || "";
};

// RSS providers expose story photos in different fields (enclosure, media:content,
// media:thumbnail, or an img tag inside description/content). Prefer those per-story
// image URLs; do not mistake a feed-wide logo for a story photo.
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const validImageUrl = (value) => {
  let url = String(value ?? "").trim()
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");
  if (url.startsWith("//")) url = "https:" + url;
  return /^https?:\/\//i.test(url) ? url : "";
};
const mediaUrl = (value) => {
  for (const entry of asArray(value)) {
    if (typeof entry === "string") {
      const direct = validImageUrl(entry);
      if (direct) return direct;
    }
    if (entry && typeof entry === "object") {
      const candidate = validImageUrl(entry["@_url"] || entry["@_href"] || entry["@_src"] || entry.url || entry.href || entry.src);
      const type = String(entry["@_type"] || entry.type || "").toLowerCase();
      if (candidate && (!type || type.startsWith("image/"))) return candidate;
    }
  }
  return "";
};
const imageOf = (item) => {
  const directCandidates = [
    mediaUrl(item.enclosure),
    mediaUrl(item["media:content"]),
    mediaUrl(item["media:thumbnail"]),
    mediaUrl(item["itunes:image"]),
    mediaUrl(item.thumbnail),
    mediaUrl(item.image),
    mediaUrl(item.content)
  ];
  const direct = directCandidates.find(Boolean);
  if (direct) return direct;

  // Some RSS feeds put the thumbnail inside HTML in description/encoded content.
  const htmlFields = [
    item.description?.["#text"] ?? item.description,
    item.summary?.["#text"] ?? item.summary,
    item["content:encoded"],
    item.content?.["#text"]
  ];
  for (const field of htmlFields) {
    if (typeof field !== "string") continue;
    const html = field
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'");
    const match = html.match(/<(?:img|source)\b[^>]*(?:src|data-src|data-original)\s*=\s*["']([^"']+)["'][^>]*>/i)
      || html.match(/\b(?:src|data-src|data-original)\s*=\s*["']([^"']+)["']/i);
    const candidate = validImageUrl(match?.[1]);
    if (candidate) return candidate;
  }
  return "";
};
let imported = 0, skipped = 0, failedFeeds = 0;
for (const feed of feeds) {
  try {
    const response = await fetch(feed.url, {
      headers: { "user-agent": "OCT-News-24-RSS-Aggregator/1.0 (source attribution enabled)" },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const xml = await response.text();
    const parsed = parser.parse(xml);
    const items = itemsOf(parsed).slice(0, 12);
    for (const item of items) {
      const title = clean(item.title?.["#text"] ?? item.title);
      const url = linkOf(item).trim();
      const summary = clean(item.description?.["#text"] ?? item.description ?? item.summary?.["#text"] ?? item.summary ?? item["content:encoded"]);
      const imageUrl = imageOf(item);
      if (!title || !url.startsWith("http")) { skipped++; continue; }
      const { data: existing, error: findError } = await supabase
        .from("news").select("id,image_url").eq("title", title).limit(1);
      if (findError) throw findError;
      if (existing?.length) {
        // Backfill photos for stories already imported before image extraction was added.
        if (imageUrl && !existing[0].image_url) {
          const { error: imageUpdateError } = await supabase
            .from("news").update({ image_url: imageUrl }).eq("id", existing[0].id);
          if (imageUpdateError) throw imageUpdateError;
          console.log(`Added missing photo: ${title.slice(0, 90)}`);
        }
        skipped++;
        continue;
      }
      // The editor's rule: never add a new RSS story without a story photo.
      if (!imageUrl) {
        skipped++;
        console.log(`Skipped (no story photo): ${title.slice(0, 90)}`);
        continue;
      }
      const content = [
        summary ? summary.slice(0, 900) : "মূল সংবাদ ও বিস্তারিত জানতে মূল সংবাদসূত্রের লিংকে যান।",
        "",
        "সংবাদসূত্র: " + feed.name,
        "মূল প্রতিবেদন: " + url,
        "নোট: এটি RSS-এ প্রকাশিত শিরোনাম ও সংক্ষিপ্ত বিবরণের ভিত্তিতে স্বয়ংক্রিয়ভাবে যুক্ত হয়েছে।"
      ].join("\n");
      const { error: insertError } = await supabase.from("news").insert({
        title: title.slice(0, 250),
        content,
        category: feed.category,
        video_url: url,
        ...(imageUrl ? { image_url: imageUrl } : {}),
        is_published: true,
        is_breaking: false
      });
      if (insertError) {
        if (insertError.code === "23505") { skipped++; continue; }
        throw insertError;
      }
      imported++;
    }
    console.log(`Processed ${feed.name}: ${items.length} RSS items`);
  } catch (error) {
    failedFeeds++;
    console.error(`Feed failed (${feed.name}): ${error.message}`);
  }
}
console.log(`RSS import complete. Imported=${imported}, skipped=${skipped}, failedFeeds=${failedFeeds}`);
if (failedFeeds === feeds.length) process.exitCode = 1;
