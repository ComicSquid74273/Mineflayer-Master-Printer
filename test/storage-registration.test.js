'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const {
  DEFAULT_ANCHOR,
  canonicalStorageBlock,
  createContainerSnapshot,
  describeContainerItem,
  selectNextDumpContainer,
  getPlatformBounds,
  isInsidePlatformBounds,
  isOverworld,
  openStorageContainerWithRetry,
  resolveStorageOpenTimeoutMs
} = require('../src/storage-registration')

const fakeBot = {
  registry: {
    items: {
      1: { name: 'white_concrete', displayName: 'White Concrete' },
      2: { name: 'black_concrete', displayName: 'Black Concrete' },
      3: { name: 'red_shulker_box', displayName: 'Red Shulker Box' }
    }
  }
}

test('storage open timeout expands with live bot latency', () => {
  const bot = { username: 'ComicBot', players: { ComicBot: { ping: 12916 } } }
  assert.equal(resolveStorageOpenTimeoutMs(bot, 6000), 27832)
  assert.equal(resolveStorageOpenTimeoutMs(bot, 30000), 30000)
})

test('decodes nested shulker items from modern container components without opening the shulker', () => {
  const componentShulker = {
    name: 'red_shulker_box',
    count: 1,
    components: [
      {
        type: 'container',
        data: {
          contents: [
            { slot: 0, itemId: 1, itemCount: 64 },
            { slot: 1, itemId: 2, itemCount: 32 }
          ]
        }
      }
    ]
  }

  const described = describeContainerItem(fakeBot, componentShulker, 0)
  assert.equal(described.name, 'red_shulker_box')
  assert.equal(described.isShulker, true)
  assert.equal(described.contents.length, 2)
  assert.deepEqual(described.contents[0], {
    slot: 0,
    name: 'white_concrete',
    displayName: 'White Concrete',
    count: 64,
    isShulker: false,
    contents: []
  })
  assert.equal(described.contents[1].count, 32)
})

test('decodes nested shulker items from legacy BlockEntityTag NBT', () => {
  const nbtTag = {
    type: 'compound',
    value: {
      BlockEntityTag: {
        type: 'compound',
        value: {
          Items: {
            type: 'list',
            value: {
              type: 'compound',
              value: [
                {
                  Slot: { type: 'byte', value: 4 },
                  id: { type: 'string', value: 'minecraft:black_concrete' },
                  Count: { type: 'byte', value: 64 }
                }
              ]
            }
          }
        }
      }
    }
  }
  const legacyShulker = {
    name: 'shulker_box',
    count: 1,
    nbt: nbtTag
  }

  const described = describeContainerItem(fakeBot, legacyShulker, 2)
  assert.equal(described.name, 'shulker_box')
  assert.equal(described.contents.length, 1)
  assert.equal(described.contents[0].slot, 4)
  assert.equal(described.contents[0].name, 'black_concrete')
  assert.equal(described.contents[0].count, 64)
})

test('snapshots index materials and classify trapped dump chests', () => {
  const block = { name: 'chest', position: { x: -325, y: 97, z: -98 } }
  const container = {
    inventoryStart: 27,
    slots: [
      {
        name: 'red_shulker_box',
        count: 1,
        components: [{
          type: 'container',
          data: { contents: [{ slot: 0, itemId: 1, itemCount: 64 }] }
        }]
      }
    ]
  }
  const snapshot = createContainerSnapshot(fakeBot, block, container)
  assert.equal(snapshot.purpose, 'materials')
  assert.equal(snapshot.shulkerCount, 1)
  assert.equal(snapshot.materialTotals.white_concrete, 64)
  assert.equal(snapshot.materialIndex.white_concrete[0].source, 'shulker')
  assert.deepEqual(snapshot.materialIndex.white_concrete[0].slotPath, [0, 0])
})

test('dump container rollover selects the first non-full trapped chest in order', () => {
  const registration = {
    dumpContainers: [
      { containerId: '1', order: 1, full: true, freeSlots: 0 },
      { containerId: '2', order: 2, full: false, freeSlots: 12 },
      { containerId: '3', order: 3, full: false, freeSlots: 27 }
    ]
  }
  const next = selectNextDumpContainer(registration)
  assert.equal(next.containerId, '2')
  assert.equal(DEFAULT_ANCHOR.x, -326)
})

test('platform bounding box enforces user dimension limits around anchor', () => {
  const anchor = { x: -326, y: 97, z: -100 }
  const bounds = getPlatformBounds(anchor)
  assert.equal(bounds.minX, -376)
  assert.equal(bounds.maxX, -276)
  assert.equal(bounds.minY, 98)
  assert.equal(bounds.maxY, 102)
  assert.equal(bounds.minZ, -104)
  assert.equal(bounds.maxZ, -96)

  assert.equal(isInsidePlatformBounds({ x: -326, y: 98, z: -100 }, anchor), true)
  assert.equal(isInsidePlatformBounds({ x: -376, y: 97, z: -104 }, anchor), false)
  assert.equal(isInsidePlatformBounds({ x: -376, y: 98, z: -104 }, anchor), true)
  assert.equal(isInsidePlatformBounds({ x: -276, y: 102, z: -96 }, anchor), true)
  // Outside in X
  assert.equal(isInsidePlatformBounds({ x: -377, y: 98, z: -100 }, anchor), false)
  assert.equal(isInsidePlatformBounds({ x: -275, y: 98, z: -100 }, anchor), false)
  // Outside in Y
  assert.equal(isInsidePlatformBounds({ x: -326, y: 96, z: -100 }, anchor), false)
  assert.equal(isInsidePlatformBounds({ x: -326, y: 103, z: -100 }, anchor), false)
  // Outside in Z
  assert.equal(isInsidePlatformBounds({ x: -326, y: 98, z: -105 }, anchor), false)
  assert.equal(isInsidePlatformBounds({ x: -326, y: 98, z: -95 }, anchor), false)
})

test('connected double chest halves resolve to one canonical storage block', () => {
  const right = {
    name: 'chest',
    type: 54,
    metadata: 2,
    position: new Vec3(-325, 98, -103),
    getProperties: () => ({ facing: 'north', type: 'right' })
  }
  const left = {
    name: 'chest',
    type: 54,
    metadata: 4,
    position: new Vec3(-324, 98, -103),
    getProperties: () => ({ facing: 'north', type: 'left' })
  }
  const blocks = new Map([
    [right.position.toString(), right],
    [left.position.toString(), left]
  ])
  const bot = {
    blockAt(position) { return blocks.get(position.toString()) || null },
    supportFeature() { return false }
  }

  assert.equal(canonicalStorageBlock(bot, right), right)
  assert.equal(canonicalStorageBlock(bot, left), right)
})

test('double chest deduplication falls back to facing when left/right type is unavailable', () => {
  const west = {
    name: 'trapped_chest',
    type: 146,
    position: new Vec3(-326, 98, -104),
    getProperties: () => ({ facing: 'east' })
  }
  const east = {
    name: 'trapped_chest',
    type: 146,
    position: new Vec3(-326, 98, -103),
    getProperties: () => ({ facing: 'east' })
  }
  const blocks = new Map([
    [west.position.toString(), west],
    [east.position.toString(), east]
  ])
  const bot = {
    blockAt(position) { return blocks.get(position.toString()) || null },
    supportFeature() { return false }
  }

  assert.equal(canonicalStorageBlock(bot, west), west)
  assert.equal(canonicalStorageBlock(bot, east), west)
})

test('storage container open retries after timeout and succeeds', async () => {
  const bot = new EventEmitter()
  const primary = new Vec3(-325, 98, -103)
  const partner = new Vec3(-325, 98, -104)
  const activatedPositions = []
  let activations = 0
  bot.activateBlock = async (block) => {
    activations++
    activatedPositions.push(block.position.toString())
    if (activations === 2) setTimeout(() => bot.emit('windowOpen', { close() {} }), 1)
  }
  const result = await openStorageContainerWithRetry(bot, {
    name: 'chest',
    position: primary
  }, {
    timeoutMs: 10,
    retryDelayMs: 1,
    alternateBlocks: [{ name: 'chest', position: partner }]
  })

  assert.equal(result.attempts, 2)
  assert.equal(activations, 2)
  assert.deepEqual(activatedPositions, [primary.toString(), partner.toString()])
})

test('dimension check identifies overworld and rejects nether and end', () => {
  assert.equal(isOverworld({ game: { dimension: 'minecraft:overworld' } }), true)
  assert.equal(isOverworld({ game: { dimension: 'overworld' } }), true)
  assert.equal(isOverworld({ game: { dimension: 'minecraft:the_nether' } }), false)
  assert.equal(isOverworld({ game: { dimension: 'minecraft:the_end' } }), false)
})
