import type dmp from 'diff-match-patch'
import type Context from './contexts/context.js'
import type DiffContext from './contexts/diff.js'
import { HASH_PREFIX, INDEX_PREFIX, INSERT_PREFIX, MODIFY_PREFIX, REMOVE_PREFIX } from './filters/arrays.js'

export interface Options {
    objectHash?: (item: object, index?: number) => string | undefined
    matchByPosition?: boolean
    arrays?: {
        detectMove?: boolean
        includeValueOnMove?: boolean
        dedupeHashInserts?: boolean
        // NOTE: will be used in a potential future version
        // replaceExistingInserts?: boolean
    }
    textDiff?: {
        diffMatchPatch: typeof dmp
        minLength?: number
    }
    propertyFilter?: (name: string, context: DiffContext) => boolean
    cloneDiffValues?: boolean | ((value: unknown) => unknown)
}

export type AddedDelta = [unknown]
export type ModifiedDelta = [unknown, unknown]
export type DeletedDelta = [unknown, 0, 0]

export interface ObjectDelta {
    [property: string]: Delta | HashDelta
}

export interface ArrayDelta {
    _t: 'a'
    [index: number | `${number}`]: Delta
    [index: `_${number}`]: DeletedDelta | MovedDelta
}

export type ArrayDeltaIndex = '_t' | number | `${number}` | `_${number}`

export type MovedDelta = [unknown, number, 3]

export interface HashArrayDelta {
    _t: 'a'
    // NOTE: this is only for types
    [index: number | `${number}`]: HashDelta
    [index: HashArrayDeltaIndex]: HashDelta
}

export type HashPrefixTypes = typeof REMOVE_PREFIX | typeof INSERT_PREFIX | typeof MODIFY_PREFIX

export type HashIndex = `${typeof INDEX_PREFIX | typeof HASH_PREFIX}${string}`

export type HashArrayDeltaIndex = `${HashPrefixTypes}${HashIndex}`

export type HashArrayAddedDelta = [unknown, number, 4]

export type HashArrayMovedDelta = [unknown, number, number, 3]

export type HashArrayDeletedDelta = [unknown, number, 0, 0]

export type HashDelta =
    | HashArrayAddedDelta
    | ModifiedDelta
    | HashArrayDeletedDelta
    | ObjectDelta
    | HashArrayDelta
    | HashArrayMovedDelta
    | TextDiffDelta
    | undefined

export type TextDiffDelta = [string, 0, 2]

export type Delta =
    | AddedDelta
    | ModifiedDelta
    | DeletedDelta
    | ObjectDelta
    | ArrayDelta
    | MovedDelta
    | TextDiffDelta
    | undefined

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// biome-ignore lint/suspicious/noExplicitAny:
export interface Filter<TContext extends Context<any>> {
    (context: TContext): void
    filterName: string
}
