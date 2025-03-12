import DiffContext from '../contexts/diff.js'
import PatchContext from '../contexts/patch.js'
import ReverseContext from '../contexts/reverse.js'

import lcs from './lcs.js'

import type {
    AddedDelta,
    ArrayDelta,
    ArrayDeltaIndex,
    DeletedDelta,
    Delta,
    Filter,
    HashArrayDeletedDelta,
    HashArrayDelta,
    HashArrayDeltaIndex,
    HashArrayMovedDelta,
    HashDelta,
    HashIndex,
    HashPrefixTypes,
    ModifiedDelta,
    MovedDelta,
    ObjectDelta,
    Options,
    TextDiffDelta,
} from '../types.js'

const ARRAY_REMOVE = 0
const ARRAY_MOVE = 3

export const REMOVE_PREFIX = '-'
export const INSERT_PREFIX = '+'
export const MODIFY_PREFIX = '!'

export const INDEX_PREFIX = '@'
export const HASH_PREFIX = '#'

function hashOrIndex(object: Record<string, unknown>, index: number, matchContext: Options): HashIndex {
    let hash
    if (matchContext.objectHash) {
        hash = matchContext.objectHash(object, index)
    }
    if (hash !== undefined) {
        return `${HASH_PREFIX}${hash}`
    }
    return `${INDEX_PREFIX}${index}`
}

function arraysHaveMatchByRef(array1: readonly unknown[], array2: readonly unknown[], len1: number, len2: number) {
    for (let index1 = 0; index1 < len1; index1++) {
        const val1 = array1[index1]
        for (let index2 = 0; index2 < len2; index2++) {
            const val2 = array2[index2]
            if (index1 !== index2 && val1 === val2) {
                return true
            }
        }
    }
    return false
}

export interface MatchContext {
    objectHash?: ((item: object, index?: number) => string | undefined) | undefined
    matchByPosition?: boolean | undefined
    hashCache1?: (string | undefined)[]
    hashCache2?: (string | undefined)[]
}

function matchItems(
    array1: readonly unknown[],
    array2: readonly unknown[],
    index1: number,
    index2: number,
    context: MatchContext,
) {
    const value1 = array1[index1]
    const value2 = array2[index2]
    if (value1 === value2) {
        return true
    }
    if (typeof value1 !== 'object' || typeof value2 !== 'object') {
        return false
    }
    const objectHash = context.objectHash
    if (!objectHash) {
        // no way to match objects was provided, try match by position
        return context.matchByPosition && index1 === index2
    }
    context.hashCache1 = context.hashCache1 || []
    let hash1 = context.hashCache1[index1]
    if (typeof hash1 === 'undefined') {
        context.hashCache1[index1] = hash1 = objectHash(value1 as object, index1)
    }
    if (typeof hash1 === 'undefined') {
        return false
    }
    context.hashCache2 = context.hashCache2 || []
    let hash2 = context.hashCache2[index2]
    if (typeof hash2 === 'undefined') {
        context.hashCache2[index2] = hash2 = objectHash(value2 as object, index2)
    }
    if (typeof hash2 === 'undefined') {
        return false
    }
    return hash1 === hash2
}

/**
 * This `arrays` filter is the default variant for `diff` and
 * should be used when no custom index/hash is desired for the array indices
 *
 * The array delta will generate indices like these
 * @example
 * delta = {
 *   _t: 'a',
 *   0: innerDelta0,
 *   1: innerDelta1,
 *   2: innerDelta2,
 * };
 */
export const diffFilter: Filter<DiffContext> = function arraysDiffFilter(context) {
    if (!context.leftIsArray) {
        return
    }

    const matchContext: MatchContext = {
        objectHash: context.options?.objectHash,
        matchByPosition: context.options?.matchByPosition,
    }
    let commonHead = 0
    let commonTail = 0
    let index: number
    let index1: number
    let index2: number
    const array1 = context.left as readonly unknown[]
    const array2 = context.right as readonly unknown[]
    const len1 = array1.length
    const len2 = array2.length

    let child: DiffContext

    if (len1 > 0 && len2 > 0 && !matchContext.objectHash && typeof matchContext.matchByPosition !== 'boolean') {
        matchContext.matchByPosition = !arraysHaveMatchByRef(array1, array2, len1, len2)
    }

    // separate common head
    while (commonHead < len1 && commonHead < len2 && matchItems(array1, array2, commonHead, commonHead, matchContext)) {
        index = commonHead
        child = new DiffContext(array1[index], array2[index])
        context.push(child, index)
        commonHead++
    }
    // separate common tail
    while (
        commonTail + commonHead < len1 &&
        commonTail + commonHead < len2 &&
        matchItems(array1, array2, len1 - 1 - commonTail, len2 - 1 - commonTail, matchContext)
    ) {
        index1 = len1 - 1 - commonTail
        index2 = len2 - 1 - commonTail
        child = new DiffContext(array1[index1], array2[index2])
        context.push(child, index2)
        commonTail++
    }
    let result:
        | {
              _t: 'a'
              [index: number]: AddedDelta
              [index: `_${number}`]: MovedDelta | DeletedDelta
          }
        | undefined
    if (commonHead + commonTail === len1) {
        if (len1 === len2) {
            // arrays are identical
            context.setResult(undefined).exit()
            return
        }
        // trivial case, a block (1 or more consecutive items) was added
        result = result || {
            _t: 'a',
        }
        for (index = commonHead; index < len2 - commonTail; index++) {
            result[index] = [array2[index]]
        }
        context.setResult(result).exit()
        return
    }
    if (commonHead + commonTail === len2) {
        // trivial case, a block (1 or more consecutive items) was removed
        result = result || {
            _t: 'a',
        }
        for (index = commonHead; index < len1 - commonTail; index++) {
            result[`_${index}`] = [array1[index], 0, 0]
        }
        context.setResult(result).exit()
        return
    }
    // reset hash cache
    matchContext.hashCache1 = undefined
    matchContext.hashCache2 = undefined

    // diff is not trivial, find the LCS (Longest Common Subsequence)
    const trimmed1 = array1.slice(commonHead, len1 - commonTail)
    const trimmed2 = array2.slice(commonHead, len2 - commonTail)
    const seq = lcs.get(trimmed1, trimmed2, matchItems, matchContext)
    const removedItems = []
    result = result || {
        _t: 'a',
    }
    for (index = commonHead; index < len1 - commonTail; index++) {
        if (seq.indices1.indexOf(index - commonHead) < 0) {
            // removed
            result[`_${index}`] = [array1[index], 0, 0]
            removedItems.push(index)
        }
    }

    let detectMove = true
    if (context.options?.arrays && context.options.arrays.detectMove === false) {
        detectMove = false
    }
    let includeValueOnMove = false
    if (context.options?.arrays?.includeValueOnMove) {
        includeValueOnMove = true
    }

    const removedItemsLength = removedItems.length
    for (index = commonHead; index < len2 - commonTail; index++) {
        const indexOnArray2 = seq.indices2.indexOf(index - commonHead)
        if (indexOnArray2 < 0) {
            // added, try to match with a removed item and register as position move
            let isMove = false
            if (detectMove && removedItemsLength > 0) {
                for (let removeItemIndex1 = 0; removeItemIndex1 < removedItemsLength; removeItemIndex1++) {
                    index1 = removedItems[removeItemIndex1]
                    if (matchItems(trimmed1, trimmed2, index1 - commonHead, index - commonHead, matchContext)) {
                        // store position move as: [originalValue, newPosition, ARRAY_MOVE]
                        result[`_${index1}`]?.splice(1, 2, index, ARRAY_MOVE)
                        if (!includeValueOnMove) {
                            // don't include moved value on diff, to save bytes
                            result[`_${index1}`][0] = ''
                        }

                        index2 = index
                        child = new DiffContext(array1[index1], array2[index2])
                        context.push(child, index2)
                        removedItems.splice(removeItemIndex1, 1)
                        isMove = true
                        break
                    }
                }
            }
            if (!isMove) {
                // added
                result[index] = [array2[index]]
            }
        } else {
            // match, do inner diff
            index1 = seq.indices1[indexOnArray2] + commonHead
            index2 = seq.indices2[indexOnArray2] + commonHead
            child = new DiffContext(array1[index1], array2[index2])
            context.push(child, index2)
        }
    }

    context.setResult(result).exit()
}
diffFilter.filterName = 'arrays'

/**
 * This `arrays` filter is the hash variant for `diff` and
 * should be used when custom index/hash is desired for the array indices
 *
 * The hash array delta will generate indices like these
 * @example
 * delta = {
 *   _t: 'a',
 *   // number index with prefixes as hash
 *   "+@4": innerDelta0,
 *   // numeric db id with prefixes as hash
 *   "!#5198": innerDelta1,
 *   // uuid with prefixes as hash
 *   "-#f3f2e850-b5d4-11ef-ac7e-96584d5248b2": innerDelta2,
 * };
 */
export function hashDiffFilter(context: DiffContext) {
    if (!context.leftIsArray) {
        return
    }

    const matchContext: MatchContext = {
        objectHash: context.options && context.options.objectHash,
        matchByPosition: context.options && context.options.matchByPosition,
    }
    let commonHead = 0
    let commonTail = 0
    let index: number
    let index1: number
    let index2: number
    const array1 = context.left as readonly unknown[]
    const array2 = context.right as readonly unknown[]
    const len1 = array1.length
    const len2 = array2.length

    let child: DiffContext
    let hashKey: HashIndex

    if (len1 > 0 && len2 > 0 && !matchContext.objectHash && typeof matchContext.matchByPosition !== 'boolean') {
        matchContext.matchByPosition = !arraysHaveMatchByRef(array1, array2, len1, len2)
    }

    // separate common head
    while (commonHead < len1 && commonHead < len2 && matchItems(array1, array2, commonHead, commonHead, matchContext)) {
        index = commonHead
        child = new DiffContext(array1[index], array2[index])
        hashKey = hashOrIndex(array1[index] as Record<string, unknown>, index, matchContext)
        context.push(child, MODIFY_PREFIX + hashKey)
        commonHead++
    }
    // separate common tail
    while (
        commonTail + commonHead < len1 &&
        commonTail + commonHead < len2 &&
        matchItems(array1, array2, len1 - 1 - commonTail, len2 - 1 - commonTail, matchContext)
    ) {
        index1 = len1 - 1 - commonTail
        index2 = len2 - 1 - commonTail
        child = new DiffContext(array1[index1], array2[index2])
        hashKey = hashOrIndex(array2[index2] as Record<string, unknown>, index2, matchContext)
        context.push(child, MODIFY_PREFIX + hashKey)
        commonTail++
    }
    let result: HashArrayDelta | undefined
    if (commonHead + commonTail === len1) {
        if (len1 === len2) {
            // arrays are identical
            context.setResult(undefined).exit()
            return
        }
        // trivial case, a block (1 or more consecutive items) was added
        result = result || {
            _t: 'a',
        }
        for (index = commonHead; index < len2 - commonTail; index++) {
            hashKey = hashOrIndex(array2[index] as Record<string, unknown>, index, matchContext)
            result[`${INSERT_PREFIX}${INDEX_PREFIX}${hashKey}`] = [array2[index]]
        }
        context.setResult(result).exit()
        return
    }
    if (commonHead + commonTail === len2) {
        // trivial case, a block (1 or more consecutive items) was removed
        result = result || {
            _t: 'a',
        }
        for (index = commonHead; index < len1 - commonTail; index++) {
            hashKey = hashOrIndex(array1[index] as Record<string, unknown>, index, matchContext)
            result[`${REMOVE_PREFIX}${hashKey}`] = [array1[index], index, 0, ARRAY_REMOVE]
        }
        context.setResult(result).exit()
        return
    }
    // reset hash cache
    matchContext.hashCache1 = undefined
    matchContext.hashCache2 = undefined

    // diff is not trivial, find the LCS (Longest Common Subsequence)
    const trimmed1 = array1.slice(commonHead, len1 - commonTail)
    const trimmed2 = array2.slice(commonHead, len2 - commonTail)
    const seq = lcs.get(trimmed1, trimmed2, matchItems, matchContext)
    const removedItems = []
    result = result || {
        _t: 'a',
    }
    for (index = commonHead; index < len1 - commonTail; index++) {
        if (seq.indices1.indexOf(index - commonHead) < 0) {
            // removed
            hashKey = hashOrIndex(array1[index] as Record<string, unknown>, index, matchContext)
            result[`${REMOVE_PREFIX}${hashKey}`] = [array1[index], index, 0, ARRAY_REMOVE]
            removedItems.push(index)
        }
    }

    let detectMove = true
    if (context.options && context.options.arrays && context.options.arrays.detectMove === false) {
        detectMove = false
    }
    let includeValueOnMove = false
    if (context.options && context.options.arrays && context.options.arrays.includeValueOnMove) {
        includeValueOnMove = true
    }

    const removedItemsLength = removedItems.length
    for (index = commonHead; index < len2 - commonTail; index++) {
        const indexOnArray2 = seq.indices2.indexOf(index - commonHead)
        if (indexOnArray2 < 0) {
            // added, try to match with a removed item and register as position move
            let isMove = false
            if (detectMove && removedItemsLength > 0) {
                for (let removeItemIndex1 = 0; removeItemIndex1 < removedItemsLength; removeItemIndex1++) {
                    index1 = removedItems[removeItemIndex1]
                    if (matchItems(trimmed1, trimmed2, index1 - commonHead, index - commonHead, matchContext)) {
                        hashKey = hashOrIndex(array1[index1] as Record<string, unknown>, index1, matchContext)
                        // store position move as: [originalValue, originalPosition, newPosition, ARRAY_MOVE]
                        const movedDelta = result[`${REMOVE_PREFIX}${hashKey}`] as HashArrayMovedDelta
                        movedDelta?.splice(1, 3, index1, index, ARRAY_MOVE)
                        if (!includeValueOnMove) {
                            // don't include moved value on diff, to save bytes
                            const item = result[`${REMOVE_PREFIX}${hashKey}`]
                            if (item) item[0] = ''
                        }

                        index2 = index
                        child = new DiffContext((context.left as [])[index1], (context.right as [])[index2])
                        context.push(child, MODIFY_PREFIX + hashKey)
                        removedItems.splice(removeItemIndex1, 1)
                        isMove = true
                        break
                    }
                }
            }
            if (!isMove) {
                // added
                hashKey = hashOrIndex(array2[index] as Record<string, unknown>, index, matchContext)
                result[`${INSERT_PREFIX}${INDEX_PREFIX}${hashKey}`] = [array2[index]]
            }
        } else {
            // match, do inner diff
            index1 = seq.indices1[indexOnArray2] + commonHead
            index2 = seq.indices2[indexOnArray2] + commonHead
            child = new DiffContext((context.left as [])[index1], (context.right as [])[index2])
            hashKey = hashOrIndex(array2[index2] as Record<string, unknown>, index2, matchContext)
            context.push(child, MODIFY_PREFIX + hashKey)
        }
    }

    context.setResult(result).exit()
}
hashDiffFilter.filterName = 'arrays'

const compare = {
    numerically(this: void, a: number, b: number) {
        return a - b
    },
    numericallyBy<T>(name: { [K in keyof T]: T[K] extends number ? K : never }[keyof T]) {
        return (a: T, b: T) => (a[name] as number) - (b[name] as number)
    },
}

/**
 * This `arrays` filter is the default variant for `patch` and
 * should be used when no custom index/hash is desired for the array indices
 *
 * The array delta needs to have indices like these
 * @example
 * delta = {
 *   _t: 'a',
 *   0: innerDelta0,
 *   1: innerDelta1,
 *   2: innerDelta2,
 * };
 */
export const patchFilter: Filter<PatchContext> = function nestedPatchFilter(context) {
    if (!context.nested) {
        return
    }
    const nestedDelta = context.delta as ObjectDelta | ArrayDelta
    if (nestedDelta._t !== 'a') {
        return
    }
    let index: ArrayDeltaIndex
    let index1: ArrayDeltaIndex

    const delta = nestedDelta as ArrayDelta
    const array = context.left as unknown[]

    // first, separate removals, insertions and modifications
    let toRemove: number[] = []
    let toInsert: { index: number; value: unknown }[] = []
    const toModify: { index: number; delta: Delta }[] = []
    for (index in delta) {
        if (index !== '_t') {
            if (typeof index === 'string' && index[0] === '_') {
                const removedOrMovedIndex = index as `_${number}`
                // removed item from original array
                if (delta[removedOrMovedIndex][2] === 0 || delta[removedOrMovedIndex][2] === ARRAY_MOVE) {
                    toRemove.push(Number.parseInt(index.slice(1), 10))
                } else {
                    throw new Error(
                        `only removal or move can be applied at original array indices, invalid diff type: ${delta[removedOrMovedIndex][2]}`,
                    )
                }
            } else {
                const numberIndex = index as `${number}`
                if ((delta[numberIndex] as unknown[]).length === 1) {
                    // added item at new array
                    toInsert.push({
                        index: Number.parseInt(numberIndex, 10),
                        value: (delta[numberIndex] as AddedDelta)[0],
                    })
                } else {
                    // modified item at new array
                    toModify.push({
                        index: Number.parseInt(numberIndex, 10),
                        delta: delta[numberIndex],
                    })
                }
            }
        }
    }

    // remove items, in reverse order to avoid sawing our own floor
    toRemove = toRemove.sort(compare.numerically)
    for (index = toRemove.length - 1; index >= 0; index--) {
        index1 = toRemove[index]
        const indexDiff = delta[`_${index1}`]
        const removedValue = array.splice(index1, 1)[0]
        if (indexDiff[2] === ARRAY_MOVE) {
            // reinsert later
            toInsert.push({
                index: indexDiff[1],
                value: removedValue,
            })
        }
    }

    // insert items, in reverse order to avoid moving our own floor
    toInsert = toInsert.sort(compare.numericallyBy('index'))
    const toInsertLength = toInsert.length
    for (index = 0; index < toInsertLength; index++) {
        const insertion = toInsert[index]
        array.splice(insertion.index, 0, insertion.value)
    }

    // apply modifications
    const toModifyLength = toModify.length
    let child: PatchContext
    if (toModifyLength > 0) {
        for (index = 0; index < toModifyLength; index++) {
            const modification = toModify[index]
            child = new PatchContext(array[modification.index], modification.delta)
            context.push(child, modification.index)
        }
    }

    if (!context.children) {
        context.setResult(array).exit()
        return
    }
    context.exit()
}
patchFilter.filterName = 'arrays'

export const collectChildrenPatchFilter: Filter<PatchContext> = function collectChildrenPatchFilter(context) {
    if (!context || !context.children) {
        return
    }
    const deltaWithChildren = context.delta as ObjectDelta | ArrayDelta
    if (deltaWithChildren._t !== 'a') {
        return
    }
    const array = context.left as unknown[]
    const length = context.children.length
    let child: PatchContext
    for (let index = 0; index < length; index++) {
        child = context.children[index]
        const arrayIndex = child.childName as number
        array[arrayIndex] = child.result
    }
    context.setResult(array).exit()
}
collectChildrenPatchFilter.filterName = 'arraysCollectChildren'

/**
 * This `arrays` filter is the hash variant for `patch` and
 * should be used when custom index/hash is desired for the array indices
 *
 * The array delta needs to have indices like these
 * @example
 * delta = {
 *   _t: 'a',
 *   // number index with prefixes as hash
 *   "+@4": innerDelta0,
 *   // numeric db id with prefixes as hash
 *   "!#5198": innerDelta1,
 *   // uuid with prefixes as hash
 *   "-#f3f2e850-b5d4-11ef-ac7e-96584d5248b2": innerDelta2,
 * };
 */
export function hashPatchFilter(context: PatchContext) {
    console.log('inside hashPatchFilter')
    if (!context.nested) {
        return
    }

    const nestedDelta = context.delta as ObjectDelta | HashArrayDelta

    if (nestedDelta._t !== 'a') {
        return
    }
    // let index: HashArrayDeltaIndex | '_t' | number
    // FIXME: type number causes the for in to error as it expects type string or any
    // biome-ignore lint/suspicious/noExplicitAny:
    let index: any

    const delta = nestedDelta as HashArrayDelta
    const array = context.left as unknown[]

    const matchContext = {
        objectHash: context.options && context.options.objectHash,
    }

    // first, separate removals, insertions and modifications
    const toRemove: Record<string, boolean> = {}
    let toInsert = []
    const toModify: Record<string, HashDelta> = {}
    console.log('delta for patching: ', delta)
    for (index in delta) {
        if (index !== '_t' && typeof index !== 'number') {
            if (index[0] === REMOVE_PREFIX) {
                // removed item from original array
                const deltaWithFourItems = delta[index] as HashArrayDeletedDelta | HashArrayMovedDelta | undefined
                if (deltaWithFourItems?.[3] === ARRAY_REMOVE || deltaWithFourItems?.[3] === ARRAY_MOVE) {
                    toRemove[index.slice(1)] = true
                } else {
                    throw new Error(
                        `only removal or move can be applied at original array indices, invalid diff type: ${deltaWithFourItems?.[3]}`,
                    )
                }
            } else {
                if (index[0] === INSERT_PREFIX) {
                    // added item at new array
                    toInsert.push({
                        //FIXME: this is broken with hash additions
                        index: parseInt(index.slice(2), 10),
                        value: (delta[index] as AddedDelta | undefined)?.[0],
                    })
                } else if (index[0] === MODIFY_PREFIX) {
                    // modified item at new array
                    toModify[index.slice(1)] = delta[index]
                }
            }
        }
    }

    // remove items, by key
    let hashKey
    let indexDiff: HashArrayMovedDelta | undefined
    // let indexDiff
    let toRemoveIndexes = []
    for (index = 0; index < array.length; index++) {
        hashKey = hashOrIndex(array[index] as Record<string, unknown>, index, matchContext)
        if (toRemove[hashKey]) {
            toRemoveIndexes.push(index)
            indexDiff = delta[`${REMOVE_PREFIX}${hashKey}`] as HashArrayMovedDelta
            if (indexDiff[3] === ARRAY_MOVE) {
                // reinsert later
                toInsert.push({
                    index: indexDiff[2],
                    value: array[index],
                })
            }
            continue
        }
    }

    // remove items, in reverse order to avoid sawing our own floor
    toRemoveIndexes = toRemoveIndexes.sort(compare.numerically)
    for (index = toRemoveIndexes.length - 1; index >= 0; index--) {
        const indexToRemove = toRemoveIndexes[index]
        if (indexToRemove) {
            array.splice(indexToRemove, 1)
        }
    }

    // FIXME: the below stuff is broken because of hash indices
    // insert items, in reverse order to avoid moving our own floor
    toInsert = toInsert.sort(compare.numericallyBy('index'))
    const toInsertLength = toInsert.length
    for (index = 0; index < toInsertLength; index++) {
        const insertion = toInsert[index]
        array.splice(insertion?.index, 0, insertion?.value)
    }

    // apply modifications
    const keysToModify = Object.keys(toModify)
    const toModifyLength = keysToModify.length
    for (let j = 0; toModifyLength && j < array.length; j++) {
        hashKey = hashOrIndex(array[j] as Record<string, unknown>, j, matchContext)
        if (toModify[hashKey]) {
            const child = new PatchContext((context.left as [])[j], toModify[hashKey])
            context.push(child, j)
        }
    }

    if (!context.children) {
        context.setResult(context.left).exit()
        return
    }
    context.exit()
}
hashPatchFilter.filterName = 'arrays'

/**
 * This `arrays` filter is the default variant for `reverse` and
 * should be used when no custom index/hash is desired for the array indices
 *
 * The array delta needs to have indices like these
 * @example
 * delta = {
 *   _t: 'a',
 *   0: innerDelta0,
 *   1: innerDelta1,
 *   2: innerDelta2,
 * };
 */
export const reverseFilter: Filter<ReverseContext> = function arraysReverseFilter(context) {
    if (!context.nested) {
        const nonNestedDelta = context.delta as AddedDelta | ModifiedDelta | DeletedDelta | MovedDelta | TextDiffDelta
        if (nonNestedDelta[2] === ARRAY_MOVE) {
            const arrayMoveDelta = nonNestedDelta as MovedDelta
            context.newName = `_${arrayMoveDelta[1]}`
            context
                .setResult([
                    arrayMoveDelta[0],
                    Number.parseInt((context.childName as `_${number}`).substring(1), 10),
                    ARRAY_MOVE,
                ])
                .exit()
        }
        return
    }
    const nestedDelta = context.delta as ObjectDelta | ArrayDelta
    if (nestedDelta._t !== 'a') {
        return
    }
    const arrayDelta = nestedDelta as ArrayDelta
    let name: ArrayDeltaIndex
    let child: ReverseContext
    for (name in arrayDelta) {
        if (name === '_t') {
            continue
        }
        child = new ReverseContext(arrayDelta[name as `${number}`])
        context.push(child, name)
    }
    context.exit()
}
reverseFilter.filterName = 'arrays'

const reverseArrayDeltaIndex = (
    delta: ArrayDelta,
    index: string | number | undefined,
    itemDelta: Delta | HashDelta,
) => {
    // TODO: this needs to be checked so it doesn't break something
    if (!index) return -1
    if (typeof index === 'string' && index[0] === '_') {
        return Number.parseInt(index.substring(1), 10)
    }
    if (Array.isArray(itemDelta) && itemDelta[2] === 0) {
        return `_${index as number}` as const
    }

    let reverseIndex = +index
    for (const deltaIndex in delta) {
        const deltaItem = delta[deltaIndex as `${number}` | `_${number}`]
        if (Array.isArray(deltaItem)) {
            if (deltaItem[2] === ARRAY_MOVE) {
                const moveFromIndex = Number.parseInt(deltaIndex.substring(1), 10)
                const moveToIndex = (deltaItem as MovedDelta)[1]
                if (moveToIndex === +index) {
                    return moveFromIndex
                }
                if (moveFromIndex <= reverseIndex && moveToIndex > reverseIndex) {
                    reverseIndex++
                } else if (moveFromIndex >= reverseIndex && moveToIndex < reverseIndex) {
                    reverseIndex--
                }
            } else if (deltaItem[2] === 0) {
                const deleteIndex = Number.parseInt(deltaIndex.substring(1), 10)
                if (deleteIndex <= reverseIndex) {
                    reverseIndex++
                }
            } else if (deltaItem.length === 1 && Number.parseInt(deltaIndex, 10) <= reverseIndex) {
                reverseIndex--
            }
        }
    }

    return reverseIndex
}

/**
 * This `arraysCollectChildren` filter is the default variant for `reverse` and
 * should be used in combination with `reverseFilter` and NOT `hashReverseFilter`
 */
export const collectChildrenReverseFilter: Filter<ReverseContext> = (context) => {
    if (!context || !context.children) {
        return
    }
    const deltaWithChildren = context.delta as ObjectDelta | ArrayDelta
    if (deltaWithChildren._t !== 'a') {
        return
    }
    const arrayDelta = deltaWithChildren as ArrayDelta
    const length = context.children.length
    let child: ReverseContext
    const delta: ArrayDelta = {
        _t: 'a',
    }

    for (let index = 0; index < length; index++) {
        child = context.children[index]
        let name: `_${number}` | number | undefined = child.newName
        if (typeof name === 'undefined') {
            name = reverseArrayDeltaIndex(arrayDelta, child.childName, child.result)
        }
        if (delta[name] !== child.result) {
            // There's no way to type this well. Added as delta cast to exclude the hash delta variants
            delta[name as number] = child.result as Delta
        }
    }
    context.setResult(delta).exit()
}
collectChildrenReverseFilter.filterName = 'arraysCollectChildren'

/**
 * This `arrays` filter is the hash variant for `reverse` and
 * should be used when custom index/hash is desired for the array indices
 * and requires `collectChildrenHashReverseFilter` to be used with it as well
 *
 * The array delta needs to have indices like these
 * @example
 * delta = {
 *   _t: 'a',
 *   // number index with prefixes as hash
 *   "+@4": innerDelta0,
 *   // numeric db id with prefixes as hash
 *   "!#5198": innerDelta1,
 *   // uuid with prefixes as hash
 *   "-#f3f2e850-b5d4-11ef-ac7e-96584d5248b2": innerDelta2,
 * };
 */
export function hashReverseFilter(context: ReverseContext) {
    if (!context.nested) {
        return
    }

    const nestedDelta = context.delta as ObjectDelta | HashArrayDelta
    if (nestedDelta._t !== 'a') {
        return
    }

    const arrayDelta = nestedDelta as HashArrayDelta
    // let name: HashArrayDeltaIndex | '_t'
    // FIXME: type number causes the for in to error as it expects type string or any
    // biome-ignore lint/suspicious/noExplicitAny:
    let name: any
    let child: ReverseContext
    for (name in arrayDelta) {
        if (name === '_t') {
            continue
        }
        child = new ReverseContext(arrayDelta[name])
        context.push(child, name)
    }
    context.exit()
}
hashReverseFilter.filterName = 'arrays'

const reverseHashArrayDeltaIndex = function (
    delta: HashArrayDelta,
    index: HashArrayDeltaIndex,
    // _itemDelta: Delta | HashDelta,
): HashArrayDeltaIndex | number {
    // TODO: this needs to be checked so it doesn't break something
    if (!index) return -1
    // We neednt worry about hash indexes here
    if (index[1] === HASH_PREFIX) {
        return index
    }

    // Return a new index based on sequences of moves, inserts, and removes
    let reverseIndex = +index.slice(2)
    for (const deltaIndex in delta) {
        // const deltaItem = delta[deltaIndex]
        const deltaItem = delta[deltaIndex as HashArrayDeltaIndex]
        if (Array.isArray(deltaItem)) {
            // Handle moves
            if (deltaItem[3] === ARRAY_MOVE) {
                const moveFromIndex = (deltaItem as HashArrayMovedDelta)[1]
                const moveToIndex = (deltaItem as HashArrayMovedDelta)[2]
                if (moveToIndex === +index) {
                    return moveFromIndex
                }
                if (moveFromIndex <= reverseIndex && moveToIndex > reverseIndex) {
                    reverseIndex++
                } else if (moveFromIndex >= reverseIndex && moveToIndex < reverseIndex) {
                    reverseIndex--
                }
                // Handle removals
            } else if (deltaItem[3] === ARRAY_REMOVE) {
                const deleteIndex = (deltaItem as HashArrayDeletedDelta)[1]
                if (deleteIndex <= reverseIndex) {
                    reverseIndex++
                }
                // Handle inserts
            } else if (deltaItem.length === 1 && +deltaIndex.slice(2) <= reverseIndex) {
                reverseIndex--
            }
        }
    }

    return `${index[0] as HashPrefixTypes}${INDEX_PREFIX}${reverseIndex.toString()}`
}

/**
 * Reverse for arrays is a little bit tricky. We have two main filters–
 * collectChildrenReverseFilter and reverseFilter–where collect is one of the
 * first filters to run in the pipe, and reverse is one of the last filters to
 * run.
 *
 * In the default jsondiffpatch arrays implementation, the key of the array
 * delta object for a removal/move represents the old index of the item. However,
 * in this implementation we want to use the key to track the objectHash of the
 * item, so we need to figure out another place to store old index information.
 *
 * To do so we change the remove/move array structure to support four elements
 * instead of three:
 * [ value, oldIndex, newIndex, remove/move flag ]  (we added oldIndex)
 *
 * However, this caused an issue where array removals were first being processed
 * by trivialReverseFilter – which still uses the three-item array syntax. To
 * work around this, we move processing of array child elements into the collect
 * filter since it is one of the first filters to run and we can intercept a
 * change before its handled by trivialFilter
 *
 * So in practice, here is how an array is processed in these filters
 *
 * 1. collectChildrenReverseFilter
 *   Receives array but children haven't been processed yet, so it's ignored
 * 2. reverseFilter
 *   Receives array, iterates over child keys and pushes them onto context children
 * 3. collectChildrenReverseFilter
 *   Executed for each child, we reverse each child delta
 *   (except for modify, which can still be handled by trivialReverseFilter)
 * 4. collectChildrenReverseFilter
 *   Receives array again, fix array keys if necessary and mark array as complete
 */
export function collectChildrenHashReverseFilter(context: ReverseContext) {
    if (!context) {
        return
    }
    const matchContext = {
        objectHash: context.options && context.options.objectHash,
    }

    // Handle array element children (see function description)
    if (context.parent && context.parent.delta && (context.parent.delta as HashArrayDelta)._t === 'a') {
        // FIXME: this needs to be properly typed
        const contextDelta = context.delta as unknown[]
        // Change inserts to removals
        if (typeof context.childName === 'string' && context.childName[0] === INSERT_PREFIX) {
            const oldindex = parseInt(context.childName?.slice(2), 10)
            // FIXME: type needs to be extended on newName to support the hash variants casted to simple for now
            context.newName = (REMOVE_PREFIX +
                hashOrIndex(contextDelta[0] as Record<string, unknown>, oldindex, matchContext)) as `_${number}`
            context.setResult([contextDelta[0], oldindex, 0, ARRAY_REMOVE]).exit()
            return
        }

        // Handle move/remove
        if (typeof context.childName === 'string' && context.childName[0] === REMOVE_PREFIX) {
            // If it was originally a move, reverse the move
            if (contextDelta[3] === ARRAY_MOVE) {
                if (context.childName[1] === HASH_PREFIX) {
                    // Continue using hash for new name
                    // FIXME: type needs to be adjusted to support this operation without cast
                    context.newName = context.childName as `_${number}`
                } else {
                    // Use index for new name
                    context.newName = (REMOVE_PREFIX + INDEX_PREFIX + contextDelta[2]) as `_${number}`
                }
                context
                    .setResult([contextDelta[0], contextDelta[2], contextDelta[1], ARRAY_MOVE] as HashArrayMovedDelta)
                    .exit()
                return
            }

            // If it was originally a removal, change to an insert
            if (contextDelta[3] === ARRAY_REMOVE) {
                context.newName = (INSERT_PREFIX + INDEX_PREFIX + contextDelta[1]) as `_${number}`
                context.setResult([contextDelta[0]]).exit()
                return
            }
        }

        // If it was originally a MODIFY, let the "trivialReverseFilter" handle it
        if (typeof context.childName === 'string' && context.childName[0] === MODIFY_PREFIX) {
            return
        }

        return
    }

    // Handle processed array (see function description)
    // NOTE: the block bellow has many casts with `as` which are a hack as it was ported from pure JS
    if (context.children) {
        const deltaWithChildren = context.delta as HashArrayDelta
        if (deltaWithChildren._t !== 'a') {
            return
        }

        const length = context.children.length
        let child
        const delta: HashArrayDelta = {
            _t: 'a',
        }

        for (let index = 0; index < length; index++) {
            child = context.children[index]
            // Assign new name/index for child if not already assigned
            let name: HashArrayDeltaIndex | `_${number}` | number | undefined = child.newName
            if (typeof name === 'undefined') {
                name = reverseHashArrayDeltaIndex(deltaWithChildren, child.childName as HashArrayDeltaIndex)
            }
            if (delta[name as HashArrayDeltaIndex] !== child.result) {
                delta[name as HashArrayDeltaIndex] = child.result as HashArrayDelta
            }
        }
        context.setResult(delta).exit()
    }
}
collectChildrenHashReverseFilter.filterName = 'arraysCollectChildren'
