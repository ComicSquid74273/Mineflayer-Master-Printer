'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  isAir,
  readVarInt,
  parseSchematicBuffer,
  sliceSchematicIntoChunks,
  serializeChunkSlice
} = require('../src/schematic-loader')
const { parseChunkSliceData } = require('../src/job-manager')

test('isAir identifies all minecraft air variants', () => {
  assert.equal(isAir('air'), true)
  assert.equal(isAir('minecraft:air'), true)
  assert.equal(isAir('cave_air'), true)
  assert.equal(isAir('minecraft:void_air'), true)
  assert.equal(isAir('minecraft:stone'), false)
  assert.equal(isAir(''), true)
})

test('readVarInt correctly unpacks single and multi-byte VarInts', () => {
  const single = readVarInt(Buffer.from([0x05]), 0)
  assert.equal(single.value, 5)
  assert.equal(single.bytesRead, 1)

  const multi = readVarInt(Buffer.from([0xAC, 0x02]), 0)
  assert.equal(multi.value, 300)
  assert.equal(multi.bytesRead, 2)
})

test('parseSchematicBuffer unpacks cityfountain.schem and extracts blocks and palette', async () => {
  const filePath = path.resolve(__dirname, 'fixtures/cityfountain.schem')
  assert.ok(fs.existsSync(filePath), 'cityfountain.schem must exist in test fixtures')
  const buf = fs.readFileSync(filePath)

  const schem = await parseSchematicBuffer(buf, 'cityfountain.schem')
  assert.equal(schem.format, 'sponge')
  assert.equal(schem.width, 17)
  assert.equal(schem.height, 12)
  assert.equal(schem.length, 17)
  assert.equal(schem.blocks.length, 470)

  // Verify sample block
  const first = schem.blocks[0]
  assert.ok(first.name)
  assert.ok(first.state)
  assert.equal(typeof first.x, 'number')
  assert.equal(typeof first.y, 'number')
  assert.equal(typeof first.z, 'number')
})

test('sliceSchematicIntoChunks slices cityfountain.schem at anchor -355, 66, -88 into 4 non-empty chunks and skips empty chunks', async () => {
  const filePath = path.resolve(__dirname, 'fixtures/cityfountain.schem')
  const buf = fs.readFileSync(filePath)
  const schem = await parseSchematicBuffer(buf, 'cityfountain.schem')

  const anchor = { x: -355, y: 66, z: -88 }
  const slices = sliceSchematicIntoChunks(schem, anchor)

  // Spans X[-355..-339] (chunks -23 and -22) and Z[-88..-72] (chunks -6 and -5)
  assert.equal(slices.length, 4)

  const keys = slices.map((s) => s.key)
  assert.ok(keys.includes('-23,-6'))
  assert.ok(keys.includes('-23,-5'))
  assert.ok(keys.includes('-22,-6'))
  assert.ok(keys.includes('-22,-5'))

  const totalBlocks = slices.reduce((sum, s) => sum + s.blockCount, 0)
  assert.equal(totalBlocks, 470)

  for (const slice of slices) {
    assert.ok(slice.blockCount > 0, 'Every slice in list must be non-empty')
    assert.equal(slice.structureBounds.maxY, Math.max(...schem.blocks.map((block) => anchor.y + block.y)))
    assert.equal(slice.anchor.x, -355)
    assert.equal(slice.anchor.y, 66)
    assert.equal(slice.anchor.z, -88)

    // Verify all blocks in slice actually belong to that chunk
    for (const b of slice.blocks) {
      assert.equal(Math.floor(b.x / 16), slice.chunkX)
      assert.equal(Math.floor(b.z / 16), slice.chunkZ)
    }

    // Verify slice blocks are sorted strictly from bottom to top (ascending Y)
    for (let i = 1; i < slice.blocks.length; i++) {
      assert.ok(slice.blocks[i].y >= slice.blocks[i - 1].y, 'Blocks must be ordered from bottom to top')
    }
  }
})

test('serializeChunkSlice and parseChunkSliceData cleanly roundtrip chunk data', async () => {
  const filePath = path.resolve(__dirname, 'fixtures/cityfountain.schem')
  const buf = fs.readFileSync(filePath)
  const schem = await parseSchematicBuffer(buf, 'cityfountain.schem')

  const anchor = { x: -355, y: 66, z: -88 }
  const slices = sliceSchematicIntoChunks(schem, anchor)
  const first = slices[0]

  const serialized = serializeChunkSlice(first, { structureName: 'cityfountain.schem' })
  assert.ok(Buffer.isBuffer(serialized))

  const parsed = parseChunkSliceData(serialized, 'cityfountain_chunk.json')
  assert.ok(parsed)
  assert.equal(parsed.chunkX, first.chunkX)
  assert.equal(parsed.chunkZ, first.chunkZ)
  assert.equal(parsed.blockCount, first.blockCount)
  assert.equal(parsed.blocks.length, first.blockCount)
  assert.deepEqual(parsed.structureBounds, first.structureBounds)
  assert.deepEqual(parsed.anchor, anchor)
})

test('sliceSchematicIntoChunks skips all empty chunks across a structure grid', () => {
  // Create a 3x3 chunk structure (48 x 1 x 48 blocks)
  // Only put blocks in chunk (0,0) and chunk (2,2); leave the other 7 chunks completely empty air
  const blocks = [
    { x: 5, y: 0, z: 5, name: 'stone', state: 'minecraft:stone', properties: {} },
    { x: 40, y: 0, z: 40, name: 'stone', state: 'minecraft:stone', properties: {} }
  ]
  const mockSchem = {
    format: 'test',
    width: 48,
    height: 1,
    length: 48,
    blocks
  }

  // Anchor at (0, 64, 0)
  const slices = sliceSchematicIntoChunks(mockSchem, { x: 0, y: 64, z: 0 })

  // Out of 9 possible chunks (0..2, 0..2), only the 2 chunks with blocks are generated
  assert.equal(slices.length, 2)
  assert.equal(slices[0].key, '0,0')
  assert.equal(slices[0].blockCount, 1)
  assert.equal(slices[1].key, '2,2')
  assert.equal(slices[1].blockCount, 1)

  // Chunks (0,1), (0,2), (1,0), (1,1), (1,2), (2,0), (2,1) were skipped
  const keys = slices.map(s => s.key)
  assert.equal(keys.includes('1,1'), false, 'Empty chunk 1,1 must be skipped')
  assert.equal(keys.includes('0,1'), false, 'Empty chunk 0,1 must be skipped')
  assert.equal(keys.includes('2,0'), false, 'Empty chunk 2,0 must be skipped')
})
