import { test } from "./harness";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { WordPieceTokenizer } from "../src/semantic/tokenizer";
import { StaticModel, dot } from "../src/semantic/static-model";

const MODEL = process.env.RELATE_MODEL ?? "/home/claude/model";
type Tokenizer = Parameters<typeof WordPieceTokenizer.fromJson>[0];
const ref = JSON.parse(readFileSync(new URL("./fixtures/reference.json", import.meta.url), "utf8")) as { texts: string[]; ids: number[][]; emb: number[][] };
const tokenizerJson = () => JSON.parse(readFileSync(`${MODEL}/tokenizer.json`, "utf8")) as Tokenizer;
const have = existsSync(`${MODEL}/model.safetensors`);

test("tokenizer matches Hugging Face tokenizers exactly", () => {
	if (!have) return;
	const t = WordPieceTokenizer.fromJson(tokenizerJson());
	ref.texts.forEach((text: string, i: number) => assert.deepEqual(t.encode(text), ref.ids[i], text));
});

test("8-bit model matches model2vec embeddings", () => {
	if (!have) return;
	const buf = readFileSync(`${MODEL}/model.safetensors`);
	const packed = StaticModel.pack("potion-base-8M", tokenizerJson(), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
	const m = StaticModel.unpack(packed);
	ref.texts.forEach((text: string, i: number) => {
		const v = m.encode(text);
		const r = Float32Array.from(ref.emb[i]);
		if (!v) {
			assert.ok(r.every((x: number) => x === 0), text);
			return;
		}
		assert.ok(dot(v, r) > 0.999, `${text}: ${dot(v, r)}`);
	});
	const a = m.encode("Frodo carries the Ring")!;
	const b = m.encode("the hobbit bears the ring of power")!;
	const c = m.encode("a recipe for lemon cake")!;
	assert.ok(dot(a, b) > dot(a, c));
});
