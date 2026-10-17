'use strict'

const nbt = require('prismarine-nbt')

function isAir(name) {
  const n = String(name || '').toLowerCase()
  return !n || n === 'air' || n === 'minecraft:air' || n === 'cave_air' || n === 'minecraft:cave_air' || n === 'void_air' || n === 'minecraft:void_air'
}

function readVarInt(buffer, offset = 0) {
  let value = 0
  let length = 0
  let b
  do {
    if (offset >= buffer.length) throw new Error('Unexpected buffer end while reading VarInt')
    b = buffer[offset++]
    value |= (b & 0x7F) << (length++ * 7)
    if (length > 5) throw new Error('VarInt is too large')
  } while ((b & 0x80) !== 0)
  return { value, bytesRead: length }
}

function unpackVarIntArray(buffer, expectedCount) {
  const values = []
  let offset = 0
  while (offset < buffer.length) {
    if (expectedCount != null && values.length >= expectedCount) break
    const { value, bytesRead } = readVarInt(buffer, offset)
    values.push(value)
    offset += bytesRead
  }
  return values
}

function parseLitematicaBitArray(longsRaw, bitsPerEntry, arraySize) {
  const longs = longsRaw.map(BigInt)
  const mask = (1n << BigInt(bitsPerEntry)) - 1n
  const result = new Int32Array(arraySize)

  for (let i = 0; i < arraySize; i++) {
    const startOffset = i * bitsPerEntry
    const startArrIndex = Math.floor(startOffset / 64)
    const endArrIndex = Math.floor(((i + 1) * bitsPerEntry - 1) / 64)
    const startBitOffset = BigInt(startOffset % 64)

    let val
    if (startArrIndex === endArrIndex) {
      val = Number((BigInt.asUintN(64, longs[startArrIndex]) >> startBitOffset) & mask)
    } else {
      const endOffset = BigInt(64 - Number(startBitOffset))
      val = Number(((BigInt.asUintN(64, longs[startArrIndex]) >> startBitOffset) | (BigInt.asUintN(64, longs[endArrIndex]) << endOffset)) & mask)
    }
    result[i] = val
  }
  return result
}

function parseLitematica(simplified) {
  const regions = simplified.Regions || {}
  const allBlocks = []
  let globalWidth = 0
  let globalHeight = 0
  let globalLength = 0

  for (const [regionName, region] of Object.entries(regions)) {
    if (!region || !region.Size || !region.BlockStatePalette || !region.BlockStates) continue

    const sizeX = Math.abs(region.Size.x)
    const sizeY = Math.abs(region.Size.y)
    const sizeZ = Math.abs(region.Size.z)
    const volume = sizeX * sizeY * sizeZ
    const palette = region.BlockStatePalette
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)))

    const unpackedIndices = parseLitematicaBitArray(region.BlockStates, bits, volume)
    const posX = region.Position ? region.Position.x : 0
    const posY = region.Position ? region.Position.y : 0
    const posZ = region.Position ? region.Position.z : 0

    // Adjust for negative size directions
    const minX = region.Size.x < 0 ? posX + region.Size.x + 1 : posX
    const minY = region.Size.y < 0 ? posY + region.Size.y + 1 : posY
    const minZ = region.Size.z < 0 ? posZ + region.Size.z + 1 : posZ

    for (let y = 0; y < sizeY; y++) {
      for (let z = 0; z < sizeZ; z++) {
        for (let x = 0; x < sizeX; x++) {
          const index = (y * sizeX * sizeZ) + (z * sizeX) + x
          const paletteId = unpackedIndices[index]
          const state = palette[paletteId]
          if (!state) continue
          const rawName = state.Name || 'minecraft:air'
          if (isAir(rawName)) continue

          const relX = minX + x
          const relY = minY + y
          const relZ = minZ + z

          allBlocks.push({
            x: relX,
            y: relY,
            z: relZ,
            name: rawName.replace(/^minecraft:/, ''),
            properties: state.Properties || {},
            state: rawName
          })

          if (relX + 1 > globalWidth) globalWidth = relX + 1
          if (relY + 1 > globalHeight) globalHeight = relY + 1
          if (relZ + 1 > globalLength) globalLength = relZ + 1
        }
      }
    }
  }

  return {
    format: 'litematic',
    width: globalWidth,
    height: globalHeight,
    length: globalLength,
    blocks: allBlocks
  }
}

function parseSpongeSchematic(simplified) {
  const root = simplified.Schematic || simplified
  const width = Number(root.Width || 0)
  const height = Number(root.Height || 0)
  const length = Number(root.Length || 0)
  const volume = width * height * length

  const blocksCompound = root.Blocks || root
  const rawPalette = blocksCompound.Palette || {}
  const idToState = {}

  if (Array.isArray(rawPalette)) {
    rawPalette.forEach((item, id) => {
      idToState[id] = typeof item === 'string' ? item : item.Name
    })
  } else {
    for (const [stateStr, id] of Object.entries(rawPalette)) {
      idToState[Number(id)] = stateStr
    }
  }

  const rawData = Buffer.isBuffer(blocksCompound.Data) ? blocksCompound.Data
    : Buffer.isBuffer(blocksCompound.BlockData) ? blocksCompound.BlockData
    : Buffer.from(blocksCompound.Data || blocksCompound.BlockData || [])

  const blockIds = unpackVarIntArray(rawData, volume)
  const blocks = []

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const index = (y * length + z) * width + x
        const id = blockIds[index]
        const stateStr = idToState[id] || 'minecraft:air'
        if (isAir(stateStr)) continue

        const [baseName, propsStr] = stateStr.split('[')
        const properties = {}
        if (propsStr) {
          propsStr.replace(/\]$/, '').split(',').forEach((pair) => {
            const [k, v] = pair.split('=')
            if (k && v) properties[k.trim()] = v.trim()
          })
        }

        blocks.push({
          x,
          y,
          z,
          name: baseName.replace(/^minecraft:/, ''),
          properties,
          state: stateStr
        })
      }
    }
  }

  return {
    format: 'sponge',
    width,
    height,
    length,
    offset: root.Offset || [0, 0, 0],
    blocks
  }
}

function parseVanillaStructure(simplified) {
  const size = simplified.size || [0, 0, 0]
  const width = Number(size[0] || 0)
  const height = Number(size[1] || 0)
  const length = Number(size[2] || 0)
  const palette = simplified.palette || []
  const rawBlocks = simplified.blocks || []

  const blocks = []
  for (const b of rawBlocks) {
    const pos = b.pos || [0, 0, 0]
    const state = palette[Number(b.state || 0)]
    if (!state) continue
    const rawName = state.Name || 'minecraft:air'
    if (isAir(rawName)) continue

    blocks.push({
      x: Number(pos[0] || 0),
      y: Number(pos[1] || 0),
      z: Number(pos[2] || 0),
      name: rawName.replace(/^minecraft:/, ''),
      properties: state.Properties || {},
      state: rawName
    })
  }

  return {
    format: 'vanilla-structure',
    width,
    height,
    length,
    blocks
  }
}

async function parseSchematicBuffer(buffer, fileName = '') {
  if (!Buffer.isBuffer(buffer)) throw new Error('parseSchematicBuffer expects a Buffer')
  const { parsed } = await nbt.parse(buffer)
  const simplified = nbt.simplify(parsed)

  if (simplified.Regions) {
    return parseLitematica(simplified)
  }
  if (simplified.Schematic || (simplified.Width && (simplified.Blocks || simplified.Palette))) {
    return parseSpongeSchematic(simplified)
  }
  if (simplified.size && simplified.blocks && simplified.palette) {
    return parseVanillaStructure(simplified)
  }
  throw new Error(`Unrecognized schematic or structure format in file: ${fileName || 'unnamed'}`)
}

function sliceSchematicIntoChunks(parsedSchematic, anchor) {
  if (!parsedSchematic || !Array.isArray(parsedSchematic.blocks)) {
    throw new Error('sliceSchematicIntoChunks expects parsed schematic with blocks array')
  }
  const baseAnchor = {
    x: Math.floor(Number(anchor?.x ?? 0)),
    y: Math.floor(Number(anchor?.y ?? 0)),
    z: Math.floor(Number(anchor?.z ?? 0))
  }

  const chunkMap = new Map()

  for (const block of parsedSchematic.blocks) {
    const worldX = baseAnchor.x + block.x
    const worldY = baseAnchor.y + block.y
    const worldZ = baseAnchor.z + block.z

    const chunkX = Math.floor(worldX / 16)
    const chunkZ = Math.floor(worldZ / 16)
    const key = `${chunkX},${chunkZ}`

    let slice = chunkMap.get(key)
    if (!slice) {
      slice = {
        chunkX,
        chunkZ,
        key,
        anchor: baseAnchor,
        blockCount: 0,
        materials: {},
        blocks: [],
        minX: worldX,
        maxX: worldX,
        minY: worldY,
        maxY: worldY,
        minZ: worldZ,
        maxZ: worldZ
      }
      chunkMap.set(key, slice)
    }

    slice.blockCount++
    slice.materials[block.name] = (slice.materials[block.name] || 0) + 1
    slice.blocks.push({
      x: worldX,
      y: worldY,
      z: worldZ,
      chunkRelX: ((worldX % 16) + 16) % 16,
      chunkRelZ: ((worldZ % 16) + 16) % 16,
      name: block.name,
      properties: block.properties,
      state: block.state
    })

    if (worldX < slice.minX) slice.minX = worldX
    if (worldX > slice.maxX) slice.maxX = worldX
    if (worldY < slice.minY) slice.minY = worldY
    if (worldY > slice.maxY) slice.maxY = worldY
    if (worldZ < slice.minZ) slice.minZ = worldZ
    if (worldZ > slice.maxZ) slice.maxZ = worldZ
  }

  // Filter empty chunks (user requirement: if empty, skip chunk)
  // User requirement: start from North-West Bottom end (minimum chunkX, then minimum chunkZ)
  const slices = Array.from(chunkMap.values())
    .filter((slice) => slice.blockCount > 0)
    .sort((a, b) => a.chunkX - b.chunkX || a.chunkZ - b.chunkZ)

  const structureBounds = slices.reduce((bounds, slice) => ({
    minX: Math.min(bounds.minX, slice.minX),
    maxX: Math.max(bounds.maxX, slice.maxX),
    minY: Math.min(bounds.minY, slice.minY),
    maxY: Math.max(bounds.maxY, slice.maxY),
    minZ: Math.min(bounds.minZ, slice.minZ),
    maxZ: Math.max(bounds.maxZ, slice.maxZ)
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity
  })

  // User requirement: always start printing from North-West-Bottom end:
  // 1. Bottom to top (ascending Y)
  // 2. North to south (ascending Z)
  // 3. West to east (ascending X)
  for (const slice of slices) {
    slice.structureBounds = structureBounds
    slice.blocks.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  }

  return slices
}

function serializeChunkSlice(slice, metadata = {}) {
  const payload = {
    schemaVersion: 1,
    structureName: metadata.structureName || 'unnamed',
    anchor: slice.anchor,
    chunkX: slice.chunkX,
    chunkZ: slice.chunkZ,
    key: slice.key,
    blockCount: slice.blockCount,
    bounds: {
      minX: slice.minX,
      maxX: slice.maxX,
      minY: slice.minY,
      maxY: slice.maxY,
      minZ: slice.minZ,
      maxZ: slice.maxZ
    },
    structureBounds: slice.structureBounds || metadata.structureBounds || null,
    materials: slice.materials,
    blocks: slice.blocks
  }
  return Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
}

module.exports = {
  isAir,
  readVarInt,
  unpackVarIntArray,
  parseLitematica,
  parseSpongeSchematic,
  parseVanillaStructure,
  parseSchematicBuffer,
  sliceSchematicIntoChunks,
  serializeChunkSlice
}
