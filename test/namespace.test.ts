import { describe, it, expect } from "vitest";
import { Namespace } from "../src/index.js";

describe("Namespace", () => {
  it("v0 produces 29 bytes", () => {
    const ns = Namespace.v0("manta");
    expect(ns.bytes.length).toBe(29);
  });

  it("v0 version byte is 0", () => {
    const ns = Namespace.v0("manta");
    expect(ns.bytes[0]).toBe(0);
  });

  it("rejects id longer than 10 bytes", () => {
    expect(() => Namespace.v0("toolongnamespace")).toThrow(RangeError);
  });

  it("hex round-trips", () => {
    const ns = Namespace.v0("manta");
    const hex = ns.toHex();
    const back = Namespace.fromHex(hex);
    expect(back.toHex()).toBe(hex);
  });

  it("hex starts with 0x and has 58 hex chars", () => {
    const ns = Namespace.v0("manta");
    const hex = ns.toHex();
    expect(hex.startsWith("0x")).toBe(true);
    expect(hex.length).toBe(2 + 29 * 2);
  });

  it("base64 is non-empty", () => {
    const ns = Namespace.v0("manta");
    expect(ns.toBase64().length).toBeGreaterThan(0);
  });

  it("accepts raw bytes", () => {
    const ns = Namespace.v0(new Uint8Array([1, 2, 3, 4, 5]));
    expect(ns.bytes.length).toBe(29);
    expect(ns.bytes[28]).toBe(5);
  });

  it("version getter returns the leading byte", () => {
    expect(Namespace.v0("manta").version).toBe(0);
  });

  it("fromBytes keeps a full 29-byte namespace verbatim (incl. non-zero version)", () => {
    const raw = new Uint8Array(29);
    raw[0] = 1; // version 1
    raw[5] = 0xab; // a byte in the normally-zero region — must survive
    raw[28] = 0x07;
    const ns = Namespace.fromBytes(raw);
    expect(ns.version).toBe(1);
    expect([...ns.bytes]).toEqual([...raw]);
  });

  it("fromBytes rejects anything that is not 29 bytes", () => {
    expect(() => Namespace.fromBytes(new Uint8Array(28))).toThrow(RangeError);
    expect(() => Namespace.fromBytes(new Uint8Array(30))).toThrow(RangeError);
  });

  it("fromBase64 round-trips a full namespace", () => {
    const ns = Namespace.v0("rollup");
    expect(Namespace.fromBase64(ns.toBase64()).toBase64()).toBe(ns.toBase64());
  });

  it("fromHex preserves all 29 bytes, not just the last 10", () => {
    const raw = new Uint8Array(29);
    raw[0] = 1;
    raw[3] = 0x9c; // outside the trailing-10 id region
    raw[28] = 0x42;
    const hex = Namespace.fromBytes(raw).toHex();
    const back = Namespace.fromHex(hex);
    expect([...back.bytes]).toEqual([...raw]);
  });

  it("fromHex still accepts a short v0 id (<=10 bytes)", () => {
    const ns = Namespace.fromHex("0x6d616e7461"); // "manta" = 5 bytes
    expect(ns.bytes.length).toBe(29);
    expect(ns.version).toBe(0);
    expect(ns.toBase64()).toBe(Namespace.v0("manta").toBase64());
  });
});
