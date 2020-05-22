const path = require('path')

// @ts-check
/**
 * @param {string} diagramText
 * @param {any} context
 * @returns {string}
 */
module.exports.preprocessVegaLite = function (diagramText, context) {
  let diagramObject
  try {
    const JSON5 = require('json5')
    diagramObject = JSON5.parse(diagramText)
  } catch (e) {
    const message = `Preprocessing of Vega-Lite view specification failed, because of a parsing error:
${e}
The invalid view specification was:
${diagramText}
`
    throw addCauseToError(new Error(message), e)
  }

  if (!diagramObject || !diagramObject.data || !diagramObject.data.url) {
    return diagramText
  }

  let vfs = context.vfs
  if (typeof vfs === 'undefined' || typeof vfs.read !== 'function') {
    vfs = require('./node-fs.js')
  }
  const data = diagramObject.data
  try {
    data.values = vfs.read(data.url)
  } catch (e) {
    if (isRemoteUrl(data.url)) {
      // Only warn and do not throw an error, because the data file can perhaps be found by kroki server (https://github.com/yuzutech/kroki/issues/60)
      console.warn(`Skipping preprocessing of Vega-Lite view specification, because reading the referenced remote file '${data.url}' caused an error:\n${e}`)
      return diagramText
    }
    const message = `Preprocessing of Vega-Lite view specification failed, because reading the referenced local file '${data.url}' caused an error:\n${e}`
    throw addCauseToError(new Error(message), e)
  }

  if (!data.format) {
    // Extract extension from URL using snippet from
    // http://stackoverflow.com/questions/680929/how-to-extract-extension-from-filename-string-in-javascript
    // Same code as in Vega-Lite:
    // https://github.com/vega/vega-lite/blob/master/src/compile/data/source.ts
    let type = /(?:\.([^.]+))?$/.exec(data.url)[1]
    if (['json', 'csv', 'tsv', 'dsv', 'topojson'].indexOf(type) < 0) {
      type = 'json'
    }
    data.format = { type: type }
  }
  data.url = undefined
  // reconsider once #42 is fixed:
  // return JSON.stringify(diagramObject, undefined, 2)
  return JSON.stringify(diagramObject)
}

/**
 * @param {string} diagramText
 * @param {any} context
 * @returns {string}
 */
module.exports.preprocessPlantUML = function (diagramText, context) {
  let vfs = context.vfs
  if (typeof vfs === 'undefined' || typeof vfs.read !== 'function' || typeof vfs.exists !== 'function') {
    vfs = require('./node-fs.js')
  }
  const includeOnce = []
  const includeStack = []
  return preprocessPlantUmlIncludes(diagramText, '.', includeOnce, includeStack, vfs)
}

/**
 * @param {string} diagramText
 * @param {string} dirPath
 * @param {string[]} includeOnce
 * @param {string[]} includeStack
 * @param {any} vfs
 * @returns {string}
 */
function preprocessPlantUmlIncludes (diagramText, dirPath, includeOnce, includeStack, vfs) {
  // see: http://plantuml.com/en/preprocessing
  const regExCommentMultiLine = new RegExp('/\'([\\s\\S]*?)\'/', 'g') // only the block comment is removed
  const regExCommentSingleLine = new RegExp('.*\'.*\'.*(\\r\\n|\\n)', 'g') // the whole line is removed
  const regExInclude = new RegExp('^\\s*!(include(?:_many|_once|url|sub)?)\\s+((?:(?<=\\\\)[ ]|[^ ])+)(.*)')
  const diagramLines = diagramText.replace(regExCommentMultiLine, '').replace(regExCommentSingleLine, '').split('\n')
  const diagramProcessed = diagramLines.map(line => line.replace(
    regExInclude,
    (match, ...args) => {
      const include = args[0].toLowerCase()
      const urlSub = args[1].trim().split('!')
      const url = urlSub[0].replace(/\\ /g, ' ')
      const sub = urlSub[1]
      const result = readPlantUmlInclude(url, dirPath, includeStack, vfs)
      if (result.skip) {
        return line
      } else {
        if (include === 'include_once') {
          checkIncludeOnce(result.text, result.filePath, includeOnce)
        }
        let text = result.text
        if (sub !== undefined && sub !== null && sub !== '') {
          if (include === 'includesub') {
            text = getPlantUmlTextFromSub(text, sub)
          } else {
            const index = parseInt(sub, 10)
            if (isNaN(index)) {
              text = getPlantUmlTextFromId(text, sub)
            } else {
              text = getPlantUmlTextFromIndex(text, index)
            }
          }
        } else {
          text = getPlantUmlTextOrFirstBlock(text)
        }
        includeStack.push(result.filePath)
        text = preprocessPlantUmlIncludes(text, path.dirname(result.filePath), includeOnce, includeStack, vfs)
        includeStack.pop()
        return text
      }
    })
  )
  return diagramProcessed.join('\n')
}

/**
 * @param {string} url
 * @param {string} dirPath
 * @param {string[]} includeStack
 * @param {any} vfs
 * @returns {any}
 */
function readPlantUmlInclude (url, dirPath, includeStack, vfs) {
  let skip = false
  let text = ''
  let filePath = url
  if (url.startsWith('<')) {
    // Only warn and do not throw an error, because the std-lib includes can perhaps be found by kroki server
    console.warn(`Skipping preprocessing of PlantUML standard library include file '${url}'`)
    skip = true
  } else if (includeStack.includes(url)) {
    const message = `Preprocessing of PlantUML include failed, because recursive reading already included referenced file '${url}'`
    throw new Error(message)
  } else {
    if (isRemoteUrl(url)) {
      try {
        text = vfs.read(url)
      } catch (e) {
        // Only warn and do not throw an error, because the data file can perhaps be found by kroki server (https://github.com/yuzutech/kroki/issues/60)
        console.warn(`Skipping preprocessing of PlantUML include, because reading the referenced remote file '${url}' caused an error:\n${e}`)
        skip = true
      }
    } else {
      filePath = path.join(dirPath, url)
      if (!vfs.exists(filePath)) {
        filePath = url
      }
      if (includeStack.includes(filePath)) {
        const message = `Preprocessing of PlantUML include failed, because recursive reading already included referenced file '${filePath}'`
        throw new Error(message)
      } else {
        try {
          text = vfs.read(filePath)
        } catch (e) {
          const message = `Preprocessing of PlantUML include failed, because reading the referenced local file '${filePath}' caused an error:\n${e}`
          throw addCauseToError(new Error(message), e)
        }
      }
    }
  }
  return { skip: skip, text: text, filePath: filePath }
}

/**
 * @param {string} text
 * @param {string} sub
 * @returns {string}
 */
function getPlantUmlTextFromSub (text, sub) {
  const regEx = new RegExp(`!startsub\\s+${sub}(?:\\r\\n|\\n)([\\s\\S]*?)(?:\\r\\n|\\n)!endsub`, 'gm')
  return getPlantUmlTextRegEx(text, regEx)
}

/**
 * @param {string} text
 * @param {string} id
 * @returns {string}
 */
function getPlantUmlTextFromId (text, id) {
  const regEx = new RegExp(`@startuml\\(id=${id}\\)(?:\\r\\n|\\n)([\\s\\S]*?)(?:\\r\\n|\\n)@enduml`, 'gm')
  return getPlantUmlTextRegEx(text, regEx)
}

/**
 * @param {string} text
 * @param {RegExp} regEx
 * @returns {string}
 */
function getPlantUmlTextRegEx (text, regEx) {
  let matchedStrings = ''
  let match = regEx.exec(text)
  if (match != null) {
    matchedStrings += match[1]
    match = regEx.exec(text)
    while (match != null) {
      matchedStrings += '\n' + match[1]
      match = regEx.exec(text)
    }
  }
  return matchedStrings
}

/**
 * @param {string} text
 * @param {int} index
 * @returns {string}
 */
function getPlantUmlTextFromIndex (text, index) {
  const regEx = new RegExp('@startuml(?:\\r\\n|\\n)([\\s\\S]*?)(?:\\r\\n|\\n)@enduml', 'gm')
  let idx = -1
  let matchedStrings = ''
  let match = regEx.exec(text)
  while (match != null && idx < index) {
    if (++idx === index) {
      matchedStrings += match[1]
    } else {
      match = regEx.exec(text)
    }
  }
  return matchedStrings
}

/**
 * @param {string} text
 * @returns {string}
 */
function getPlantUmlTextOrFirstBlock (text) {
  const regEx = new RegExp('@startuml(?:\\r\\n|\\n)([\\s\\S]*?)(?:\\r\\n|\\n)@enduml', 'gm')
  let matchedStrings = text
  const match = regEx.exec(text)
  if (match != null) {
    matchedStrings = match[1]
  }
  return matchedStrings
}

/**
 * @param {string} text
 * @param {string} filePath
 * @param {string[]} includeOnce
 */
function checkIncludeOnce (text, filePath, includeOnce) {
  if (includeOnce.includes(filePath)) {
    const message = `Preprocessing of PlantUML include failed, because including multiple times referenced file '${filePath}' with '!include_once' guard`
    throw new Error(message)
  } else {
    includeOnce.push(filePath)
  }
}

/**
 * @param {Error} error
 * @param {any} causedBy
 * @returns {Error}
 */
function addCauseToError (error, causedBy) {
  if (causedBy.stack) {
    error.stack += '\nCaused by: ' + causedBy.stack
  }
  return error
}

/**
 * @param {string} string
 * @returns {boolean}
 */
function isRemoteUrl (string) {
  try {
    const url = new URL(string)
    return url.protocol !== 'file:'
  } catch (_) {
    return false
  }
}
