export const resourceLevelNames = { UHD: '极致', HD: '高清', SD: '流畅' }

export function getWWResourcePacks(data, level) {
  const names = data.bundles?.[level]?.resourcePacks
  if (!Object.hasOwn(resourceLevelNames, level) || !names?.length) {
    throw new Error(`不支持的资源等级: ${level}，可选 UHD/HD/SD`)
  }
  return names.map((name) => {
    const pack = data.resourcePacks?.[name]
    if (!pack) throw new Error(`资源等级 ${level} 缺少分包: ${name}`)
    return pack
  })
}

export function getWWResourceLevelSizes(data) {
  return Object.fromEntries(
    Object.keys(resourceLevelNames)
      .filter((level) => data.bundles?.[level])
      .map((level) => [
        level,
        getWWResourcePacks(data, level).reduce((total, pack) => {
          if (!Number.isFinite(pack.size) || pack.size < 0) {
            throw new Error(`资源等级 ${level} 的分包大小无效`)
          }
          return total + pack.size
        }, 0),
      ]),
  )
}
