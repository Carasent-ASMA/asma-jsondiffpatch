import type DiffContext from '../contexts/diff.js'
import type PatchContext from '../contexts/patch.js'
import type ReverseContext from '../contexts/reverse.js'
import type { AddedDelta, DeletedDelta, Filter, ModifiedDelta, MovedDelta, TextDiffDelta } from '../types.js'

export const diffFilter: Filter<DiffContext> = function trivialMatchesDiffFilter(context) {
    if (context.left === context.right) {
        context.setResult(undefined).exit()
        return
    }
    if (typeof context.left === 'undefined') {
        if (typeof context.right === 'function') {
            throw new Error('functions are not supported')
        }
        context.setResult([context.right]).exit()
        return
    }
    if (typeof context.right === 'undefined') {
        context.setResult([context.left, 0, 0]).exit()
        return
    }
    if (typeof context.left === 'function' || typeof context.right === 'function') {
        throw new Error('functions are not supported')
    }
    context.leftType = context.left === null ? 'null' : typeof context.left
    context.rightType = context.right === null ? 'null' : typeof context.right
    if (context.leftType !== context.rightType) {
        context.setResult([context.left, context.right]).exit()
        return
    }
    if (context.leftType === 'boolean' || context.leftType === 'number') {
        context.setResult([context.left, context.right]).exit()
        return
    }
    if (context.leftType === 'object') {
        context.leftIsArray = Array.isArray(context.left)
    }
    if (context.rightType === 'object') {
        context.rightIsArray = Array.isArray(context.right)
    }
    if (context.leftIsArray !== context.rightIsArray) {
        context.setResult([context.left, context.right]).exit()
        return
    }

    if (context.left instanceof RegExp) {
        if (context.right instanceof RegExp) {
            context.setResult([context.left.toString(), context.right.toString()]).exit()
        } else {
            context.setResult([context.left, context.right]).exit()
        }
    }
}
diffFilter.filterName = 'trivial'

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.prototype.toString.call(value) === '[object Object]'
    )
}

function getStableKey(value: unknown): string | undefined {
    if (!isPlainObject(value)) return undefined

    const id = value['id']
    if (typeof id === 'string') return id

    const questionId = value['question_id']
    if (typeof questionId === 'string') return questionId

    const properties = value['properties']
    if (isPlainObject(properties)) {
        const questionUuid = properties['question_uuid']
        if (typeof questionUuid === 'string') {
            return questionUuid
        }
    }

    return undefined
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`
    }

    if (isPlainObject(value)) {
        const keys = Object.keys(value).sort()
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
    }

    return JSON.stringify(value)
}

function mergeLegacyValue(current: unknown, inserted: unknown, path: string[] = []): unknown {
    if (Array.isArray(current) && Array.isArray(inserted)) {
        return mergeLegacyArray(current, inserted, path)
    }

    if (isPlainObject(current) && isPlainObject(inserted)) {
        return mergeLegacyObject(current, inserted, path)
    }

    return inserted
}

function mergeLegacyObject(
    current: Record<string, unknown>,
    inserted: Record<string, unknown>,
    path: string[] = [],
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...current }

    for (const key of Object.keys(inserted)) {
        result[key] = mergeLegacyValue(result[key], inserted[key], [...path, key])
    }

    return result
}

function orderItemSignature(item: unknown): string {
    if (!isPlainObject(item)) return stableStringify(item)

    const row = item['row']
    const questions = Array.isArray(item['questions'])
        ? item['questions']
              .map((q) => {
                  if (!isPlainObject(q)) return stableStringify(q)

                  return [q['cell'], q['question_id'], q['keep_cell_size']].join('|')
              })
              .sort()
        : []

    return JSON.stringify({
        row,
        questions,
    })
}

function mergeKeyedArray(
    current: unknown[],
    inserted: unknown[],
    getKey: (value: unknown) => string | number | undefined,
): unknown[] {
    const result = [...current]
    const indexByKey = new Map<string | number, number>()

    for (let i = 0; i < result.length; i++) {
        const key = getKey(result[i])
        if (typeof key !== 'undefined') {
            indexByKey.set(key, i)
        }
    }

    for (const item of inserted) {
        const key = getKey(item)

        if (typeof key === 'undefined') {
            result.push(item)
            continue
        }

        const existingIndex = indexByKey.get(key)
        if (typeof existingIndex === 'number') {
            result[existingIndex] = item
        } else {
            result.push(item)
            indexByKey.set(key, result.length - 1)
        }
    }

    return result
}

function mergeKeyedArrayPreferInsertedOrder(
    current: unknown[],
    inserted: unknown[],
    getKey: (value: unknown) => string | number | undefined,
): unknown[] {
    const result: unknown[] = []
    const seen = new Set<string | number>()

    for (const item of inserted) {
        const key = getKey(item)

        if (typeof key === 'undefined') {
            result.push(item)
            continue
        }

        if (seen.has(key)) {
            continue
        }

        seen.add(key)
        result.push(item)
    }

    for (const item of current) {
        const key = getKey(item)

        if (typeof key === 'undefined' || !seen.has(key)) {
            result.push(item)
        }
    }

    return result
}

function mergeLegacyArray(current: unknown[], inserted: unknown[], path: string[] = []): unknown[] {
    const last = path[path.length - 1]

    if (last === 'order') {
        return mergeKeyedArray(current, inserted, (v) =>
            isPlainObject(v) && typeof v['row'] === 'number' ? v['row'] : undefined,
        )
    }

    if (last === 'question_labels') {
        return mergeKeyedArrayPreferInsertedOrder(current, inserted, (v) =>
            isPlainObject(v) && typeof v['question_id'] === 'string' ? v['question_id'] : undefined,
        )
    }

    if (last === 'tabs') {
        return mergeKeyedArray(current, inserted, (v) =>
            isPlainObject(v) && typeof v['id'] === 'string' ? v['id'] : undefined,
        )
    }

    const result = [...current]
    const isOrderPath = path?.[path.length - 1] === 'order'
    const seen = new Set(result.map((item) => (isOrderPath ? orderItemSignature(item) : stableStringify(item))))

    for (const item of inserted) {
        const key = getStableKey(item)

        if (key) {
            const idx = result.findIndex((v) => getStableKey(v) === key)
            if (idx >= 0) {
                result[idx] = mergeLegacyValue(result[idx], item, path)
            } else {
                result.push(item)
            }
            continue
        }

        const fingerprint = isOrderPath ? orderItemSignature(item) : stableStringify(item)

        if (!seen.has(fingerprint)) {
            seen.add(fingerprint)
            result.push(item)
        }
    }

    return result
}

export const patchFilter: Filter<PatchContext> = function trivialMatchesPatchFilter(context) {
    if (typeof context.delta === 'undefined') {
        context.setResult(context.left).exit()
        return
    }
    context.nested = !Array.isArray(context.delta)
    if (context.nested) {
        return
    }
    const nonNestedDelta = context.delta as AddedDelta | ModifiedDelta | DeletedDelta | MovedDelta | TextDiffDelta
    if (nonNestedDelta.length === 1) {
        context.setResult(nonNestedDelta[0]).exit()
        return
    }
    if (nonNestedDelta.length === 2) {
        const [oldValue, newValue] = nonNestedDelta

        if (oldValue === null && isPlainObject(context.left) && isPlainObject(newValue)) {
            context.setResult(mergeLegacyValue(context.left, newValue)).exit()
            return
        }

        context.setResult(newValue).exit()
        return
    }
    if (nonNestedDelta.length === 3 && nonNestedDelta[2] === 0) {
        context.setResult(undefined).exit()
    }
}
patchFilter.filterName = 'trivial'

export const reverseFilter: Filter<ReverseContext> = function trivialReferseFilter(context) {
    if (typeof context.delta === 'undefined') {
        context.setResult(context.delta).exit()
        return
    }
    context.nested = !Array.isArray(context.delta)
    if (context.nested) {
        return
    }
    const nonNestedDelta = context.delta as AddedDelta | ModifiedDelta | DeletedDelta | MovedDelta | TextDiffDelta
    if (nonNestedDelta.length === 1) {
        context.setResult([nonNestedDelta[0], 0, 0]).exit()
        return
    }
    if (nonNestedDelta.length === 2) {
        context.setResult([nonNestedDelta[1], nonNestedDelta[0]]).exit()
        return
    }
    if (nonNestedDelta.length === 3 && nonNestedDelta[2] === 0) {
        context.setResult([nonNestedDelta[0]]).exit()
    }
}
reverseFilter.filterName = 'trivial'
