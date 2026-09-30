import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rasterTypeOf, SNIFF_BYTES } from './sniff.ts'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

test('the four raster formats are recognised by their first bytes', () => {
  assert.equal(rasterTypeOf(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)), 'image/png')
  assert.equal(rasterTypeOf(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0)), 'image/jpeg')
  assert.equal(rasterTypeOf(text('GIF89a......')), 'image/gif')
  assert.equal(rasterTypeOf(text('RIFF\u0000\u0000\u0000\u0000WEBP')), 'image/webp')
})

test('SVG and HTML are never a picture, whatever they are called', () => {
  assert.equal(rasterTypeOf(text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">')), undefined)
  assert.equal(rasterTypeOf(text('<!doctype html><script>alert(1)</script>')), undefined)
})

test('a RIFF that is not WebP (a WAV) is not a picture', () => {
  assert.equal(rasterTypeOf(text('RIFF\u0000\u0000\u0000\u0000WAVE')), undefined)
})

test('too few bytes, and none, are not a picture', () => {
  assert.equal(rasterTypeOf(bytes(0x89, 0x50, 0x4e)), undefined)
  assert.equal(rasterTypeOf(new Uint8Array(0)), undefined)
  assert.equal(SNIFF_BYTES, 12)
})
