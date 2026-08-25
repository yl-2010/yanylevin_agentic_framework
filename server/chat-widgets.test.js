import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WIDGETS,
  formatWidgetsAsFences,
  httpsUrl,
  normalizePins,
  normalizeWidgets,
  parseAgentReply,
} from "./chat-widgets.js";

describe("httpsUrl", () => {
  it("keeps https and rejects the rest", () => {
    assert.equal(httpsUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");
    assert.equal(httpsUrl("http://example.com/a.jpg"), "");
    assert.equal(httpsUrl("javascript:alert(1)"), "");
    assert.equal(httpsUrl("https://example.com/a.jpg extra"), "");
  });
});

describe("parseAgentReply", () => {
  it("strips widget fences and orders map first", () => {
    const raw = [
      "Nice cafes nearby.",
      "",
      "```widget html pin=juanita",
      "<h3>Cafe Juanita</h3>",
      "```",
      "",
      "```widget map",
      JSON.stringify({
        pins: [{ id: "juanita", lat: 47.705, lng: -122.207, title: "Cafe Juanita" }],
      }),
      "```",
    ].join("\n");
    const { content, widgets } = parseAgentReply(raw);
    assert.equal(content, "Nice cafes nearby.");
    assert.equal(widgets[0].type, "map");
    assert.equal(widgets[0].id, "map");
    assert.equal(widgets[0].pins[0].id, "juanita");
    assert.equal(widgets[1].type, "place");
    assert.equal(widgets[1].pinId, "juanita");
    assert.equal(widgets[1].title, "Cafe Juanita");
  });

  it("lifts leftover markdown images into image widgets", () => {
    const { content, widgets } = parseAgentReply(
      'Patio shot:\n\n![Patio](https://cdn.example.com/patio.jpg "Patio")\n\nDone.'
    );
    assert.equal(content, "Patio shot:\n\nDone.");
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].type, "image");
    assert.equal(widgets[0].url, "https://cdn.example.com/patio.jpg");
    assert.equal(widgets[0].alt, "Patio");
  });

  it("does not lift http markdown images; strips them to alt text", () => {
    const { content, widgets } = parseAgentReply("See ![x](http://evil.example/a.png)");
    assert.equal(content, "See x");
    assert.equal(widgets.length, 0);
  });

  it("parses a bare image URL fence", () => {
    const { widgets } = parseAgentReply(
      "```widget image\nhttps://cdn.example.com/a.jpg\n```"
    );
    assert.equal(widgets[0].type, "image");
    assert.equal(widgets[0].url, "https://cdn.example.com/a.jpg");
  });

  it("parses a widgets JSON array", () => {
    const { widgets, content } = parseAgentReply(
      "Hi\n\n```widgets\n" +
        JSON.stringify([
          {
            type: "map",
            pins: [{ id: "a", lat: 47.6, lng: -122.3, title: "A" }],
          },
          { type: "html", pinId: "a", html: "<p>A</p>" },
        ]) +
        "\n```"
    );
    assert.equal(content, "Hi");
    assert.equal(widgets[0].type, "map");
    assert.equal(widgets[1].type, "place");
    assert.equal(widgets[1].title, "A");
  });

  it("synthesizes pin html when the agent omits pin cards", () => {
    const { widgets } = parseAgentReply(
      "```widget map\n" +
        JSON.stringify({
          pins: [
            {
              id: "spot",
              lat: 47.6,
              lng: -122.2,
              title: "Spot",
              subtitle: "Open late",
            },
          ],
        }) +
        "\n```"
    );
    assert.equal(widgets.length, 2);
    assert.equal(widgets[1].type, "place");
    assert.equal(widgets[1].pinId, "spot");
    assert.equal(widgets[1].title, "Spot");
    assert.equal(widgets[1].subtitle, "Open late");
    assert.equal(widgets[1].lat, 47.6);
    assert.equal(widgets[1].lng, -122.2);
  });

  it("copies pin description onto the place card", () => {
    const description =
      "Neighborhood bar with a small kitchen. Good when you want a walkable drink after dinner.";
    const { widgets } = parseAgentReply(
      "```widget map\n" +
        JSON.stringify({
          pins: [
            {
              id: "spot",
              lat: 47.6,
              lng: -122.2,
              title: "Spot",
              subtitle: "Open late",
              description,
            },
          ],
        }) +
        "\n```"
    );
    assert.equal(widgets[0].pins[0].description, description);
    assert.equal(widgets[1].type, "place");
    assert.equal(widgets[1].subtitle, "Open late");
    assert.equal(widgets[1].body, description);
    assert.equal(widgets[1].lat, 47.6);
    assert.equal(widgets[1].lng, -122.2);
  });

  it("merges light and dark html fences for the same pin", () => {
    const { widgets } = parseAgentReply(
      [
        "```widget map",
        JSON.stringify({
          pins: [{ id: "juanita", lat: 47.705, lng: -122.207, title: "Cafe Juanita" }],
        }),
        "```",
        "```widget html pin=juanita theme=light",
        '<p style="color:#14181D">Patio lunch</p>',
        "```",
        "```widget html pin=juanita theme=dark",
        '<p style="color:#E9EEF2">Patio dinner</p>',
        "```",
      ].join("\n")
    );
    const card = widgets.find((w) => w.type === "place" && w.pinId === "juanita");
    assert.equal(card.title, "Cafe Juanita");
    assert.match(card.body || "", /Patio lunch/);
    assert.equal(widgets.filter((w) => w.type === "html").length, 0);
    assert.equal(widgets.filter((w) => w.type === "place").length, 1);
  });

  it("merges unpinned html by id= across themes", () => {
    const { widgets } = parseAgentReply(
      [
        "```widget html id=chart theme=light",
        "<div>light chart</div>",
        "```",
        "```widget html id=chart theme=dark",
        "<div>dark chart</div>",
        "```",
      ].join("\n")
    );
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].html, "<div>light chart</div>");
    assert.equal(widgets[0].htmlDark, "<div>dark chart</div>");
    assert.equal(widgets[0].id, "chart");
  });

  it("merges multiple map fences and caps widget count", () => {
    const pins = [];
    for (let i = 0; i < 20; i++) {
      pins.push({ id: `p${i}`, lat: 47 + i / 100, lng: -122, title: `P${i}` });
    }
    const raw =
      "```widget map\n" +
      JSON.stringify({ pins: pins.slice(0, 10) }) +
      "\n```\n```widget map\n" +
      JSON.stringify({ pins: pins.slice(10) }) +
      "\n```";
    const { widgets } = parseAgentReply(raw);
    assert.equal(widgets[0].type, "map");
    assert.equal(widgets[0].pins.length, 20);
    assert.equal(widgets.length, MAX_WIDGETS);
  });

  it("drops invalid coordinates and oversize html", () => {
    const huge = "x".repeat(90 * 1024);
    const { widgets } = parseAgentReply(
      [
        "```widget map",
        JSON.stringify({
          pins: [
            { id: "bad", lat: 999, lng: 0, title: "Bad" },
            { id: "ok", lat: 47.6, lng: -122.2, title: "Ok" },
          ],
        }),
        "```",
        "```widget html",
        huge,
        "```",
      ].join("\n")
    );
    assert.equal(widgets[0].pins.length, 1);
    assert.equal(widgets[0].pins[0].id, "ok");
    assert.ok(!widgets.some((w) => w.type === "html" && w.html === huge));
  });
});

describe("normalizePins", () => {
  it("accepts lat/lon aliases and slugs missing ids", () => {
    const pins = normalizePins([
      { latitude: 47.6, longitude: -122.3, name: "Hello Place" },
    ]);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].lat, 47.6);
    assert.equal(pins[0].title, "Hello Place");
    assert.ok(pins[0].id);
  });

  it("keeps description off subtitle", () => {
    const pins = normalizePins([
      {
        latitude: 47.6,
        longitude: -122.3,
        name: "Hello Place",
        subtitle: "Cafe",
        description: "Two sentences about the place. Another sentence.",
      },
    ]);
    assert.equal(pins[0].subtitle, "Cafe");
    assert.match(pins[0].description, /Two sentences/);
  });
});

describe("formatWidgetsAsFences", () => {
  it("round-trips through parseAgentReply", () => {
    const widgets = normalizeWidgets([
      {
        type: "map",
        pins: [{ id: "a", lat: 47.6, lng: -122.3, title: "A" }],
      },
      { type: "html", html: "<p>A</p>", htmlDark: "<p>A dark</p>", pairId: "chart" },
      { type: "image", url: "https://cdn.example.com/a.jpg", alt: "A" },
    ]);
    const fences = formatWidgetsAsFences(widgets);
    const parsed = parseAgentReply(`Intro\n\n${fences}`);
    assert.equal(parsed.content, "Intro");
    assert.equal(parsed.widgets[0].type, "map");
    assert.equal(parsed.widgets[1].type, "place");
    assert.equal(parsed.widgets[1].pinId, "a");
    assert.equal(parsed.widgets[1].lat, 47.6);
    assert.equal(parsed.widgets[1].lng, -122.3);
    assert.equal(parsed.widgets[2].type, "html");
    assert.equal(parsed.widgets[2].html, "<p>A</p>");
    assert.equal(parsed.widgets[2].htmlDark, "<p>A dark</p>");
    assert.equal(parsed.widgets[3].type, "image");
  });
});
