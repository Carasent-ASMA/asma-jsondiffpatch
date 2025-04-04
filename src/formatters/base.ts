import { HASH_PREFIX, INDEX_PREFIX } from 'src/filters/arrays.js'
import type {
    AddedDelta,
    ArrayDelta,
    DeletedDelta,
    Delta,
    HashArrayAddedDelta,
    HashArrayDeletedDelta,
    HashArrayDelta,
    HashArrayMovedDelta,
    HashDelta,
    ModifiedDelta,
    MovedDelta,
    ObjectDelta,
    TextDiffDelta,
} from '../types.js'

const trimUnderscore = (str: string) => {
    if (str.substring(0, 1) === '_') {
        return str.slice(1)
    }
    return str
}

const arrayKeyToSortNumber = (key: string) => {
    if (key === '_t') {
        return -1
    }
    if (key.substring(0, 1) === '_') {
        return Number.parseInt(key.slice(1), 10)
    }
    return Number.parseInt(key, 10) + 0.1
}

const arrayKeyComparer = (key1: string, key2: string) => arrayKeyToSortNumber(key1) - arrayKeyToSortNumber(key2)

export interface BaseFormatterContext {
    buffer: string[]
    out: (...args: string[]) => void
}

export type DeltaType =
    | 'movedestination'
    | 'unchanged'
    | 'added'
    | 'modified'
    | 'deleted'
    | 'textdiff'
    | 'moved'
    | 'node'
    | 'unknown'

export type NodeType = 'array' | 'object' | ''

interface DeltaTypeMap {
    movedestination: undefined
    unchanged: undefined
    added: AddedDelta | HashArrayAddedDelta
    modified: ModifiedDelta
    deleted: DeletedDelta | HashArrayDeletedDelta
    textdiff: TextDiffDelta
    moved: MovedDelta | HashArrayMovedDelta
    node: ObjectDelta | ArrayDelta | HashArrayDelta
}

interface MoveDestination {
    key: `_${number}`
    value: unknown
}

type Formatter<TContext extends BaseFormatterContext> = {
    [TDeltaType in keyof DeltaTypeMap as `format_${keyof DeltaTypeMap}`]: (
        context: TContext,
        delta: DeltaTypeMap[TDeltaType],
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ) => void
}

interface LineOutputPiece {
    type: 'context' | 'added' | 'deleted'
    text: string
}

interface LineOutputLocation {
    line: string
    chr: string
}

interface LineOutput {
    pieces: LineOutputPiece[]
    location: LineOutputLocation
}

abstract class BaseFormatter<TContext extends BaseFormatterContext, TFormatted = string | undefined> {
    includeMoveDestinations?: boolean

    format(delta: Delta, left?: unknown): TFormatted {
        const context: Partial<TContext> = {}
        this.prepareContext(context)
        const preparedContext = context as TContext
        this.recurse(preparedContext, delta, left)
        return this.finalize(preparedContext) as TFormatted
    }

    prepareContext(context: Partial<TContext>) {
        context.buffer = []
        context.out = function (...args) {
            this.buffer?.push(...args)
        }
    }

    typeFormattterNotFound(_context: TContext, deltaType: 'unknown'): never {
        throw new Error(`cannot format delta type: ${deltaType}`)
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    // typeFormattterErrorFormatter(
    //     _context: TContext,
    //     _err: unknown,
    //     _delta: Delta,
    //     _leftValue: unknown,
    //     _key: string | undefined,
    //     _leftKey: string | number | undefined,
    //     _movedFrom: MoveDestination | undefined,
    // ) {}
    /* eslint-enable @typescript-eslint/no-unused-vars */

    finalize({ buffer }: TContext) {
        if (Array.isArray(buffer)) {
            return buffer.join('')
        }
        return ''
    }

    recurse<TDeltaType extends keyof DeltaTypeMap>(
        context: TContext,
        delta: DeltaTypeMap[TDeltaType],
        left: unknown,
        key?: string,
        leftKey?: string | number,
        movedFrom?: MoveDestination | undefined,
        isLast?: boolean,
    ) {
        const useMoveOriginHere = delta && movedFrom
        const leftValue = useMoveOriginHere ? movedFrom.value : left

        if (typeof delta === 'undefined' && typeof key === 'undefined') {
            return undefined
        }

        const type = this.getDeltaType(delta, movedFrom)
        const nodeType = type === 'node' ? ((delta as ArrayDelta)._t === 'a' ? 'array' : 'object') : ''

        // TODO: this needs to be checked so it doesnt break with the undefined checks that were added
        if (typeof key !== 'undefined' && typeof leftKey !== 'undefined') {
            this.nodeBegin(context, key, leftKey, type, nodeType, isLast ?? false)
        } else {
            this.rootBegin(context, type, nodeType)
        }

        let typeFormattter:
            | ((
                  context: TContext,
                  delta: DeltaTypeMap[TDeltaType],
                  leftValue: unknown,
                  key: string | undefined,
                  leftKey: string | number | undefined,
                  movedFrom: MoveDestination | undefined,
              ) => void)
            | undefined
        try {
            typeFormattter =
                type !== 'unknown'
                    ? (this as Formatter<TContext>)[`format_${type}`]
                    : this.typeFormattterNotFound(context, type)
            typeFormattter.call(this, context, delta, leftValue, key, leftKey, movedFrom)
        } catch (err) {
            // this.typeFormattterErrorFormatter(context, err, delta, leftValue, key, leftKey, movedFrom)
            if (typeof console !== 'undefined' && console.error) {
                console.error((err as Error).stack)
            }
        }

        // TODO: this needs to be checked so it doesnt break with the undefined checks that were added
        if (typeof key !== 'undefined' && typeof leftKey !== 'undefined') {
            this.nodeEnd(context, key, leftKey, type, nodeType, isLast ?? false)
        } else {
            this.rootEnd(context, type, nodeType)
        }
    }

    formatDeltaChildren(context: TContext, delta: ObjectDelta | ArrayDelta | HashArrayDelta, left: unknown) {
        this.forEachDeltaKey(delta, left, (key, leftKey, movedFrom, isLast) => {
            this.recurse(
                context,
                (delta as Record<string, Delta>)[key],
                left ? (left as Record<string | number, unknown>)[leftKey] : undefined,
                key,
                leftKey,
                movedFrom,
                isLast,
            )
        })
    }

    forEachDeltaKey(
        delta: ObjectDelta | ArrayDelta | HashArrayDelta,
        left: unknown,
        fn: (
            key: string,
            leftKey: string | number,
            moveDestination: MoveDestination | undefined,
            isLast: boolean,
        ) => void,
    ) {
        const keys = Object.keys(delta)
        const arrayKeys = delta._t === 'a'
        const moveDestinations: {
            [index: string | number]: MoveDestination | undefined
        } = {}
        let name: string
        if (typeof left !== 'undefined') {
            for (name in left) {
                if (Object.prototype.hasOwnProperty.call(left, name)) {
                    if (
                        typeof (delta as Record<string, Delta>)[name] === 'undefined' &&
                        (!arrayKeys || typeof (delta as ArrayDelta)[`_${name}` as `_${number}`] === 'undefined')
                    ) {
                        keys.push(name)
                    }
                }
            }
        }
        // look for move destinations
        for (name in delta) {
            if (Object.prototype.hasOwnProperty.call(delta, name)) {
                const value = (delta as Record<string, Delta | HashDelta>)[name]
                if (Array.isArray(value) && (value[2] === 3 || value[3] === 3)) {
                    const movedDelta = value as MovedDelta | HashArrayMovedDelta
                    moveDestinations[`${movedDelta[1]}`] = {
                        key: name as `_${number}`,
                        value: left && (left as unknown[])[Number.parseInt(name.substring(1), 10)],
                    }
                    if (this.includeMoveDestinations !== false) {
                        if (
                            typeof left === 'undefined' &&
                            typeof (delta as ArrayDelta)[movedDelta[1]] === 'undefined'
                        ) {
                            keys.push(movedDelta[1].toString())
                        }
                    }
                }
            }
        }
        if (arrayKeys) {
            keys.sort(arrayKeyComparer)
        } else {
            keys.sort()
        }
        for (let index = 0, length = keys.length; index < length; index++) {
            const key = keys[index]
            if (arrayKeys && key === '_t') {
                continue
            }
            let leftKey: string | number = key
            if (arrayKeys) {
                if (key[1] !== HASH_PREFIX && key[1] !== INDEX_PREFIX) {
                    leftKey = Number.parseInt(trimUnderscore(key), 10)
                }
            }
            const isLast = index === length - 1
            fn(key, leftKey, moveDestinations[leftKey], isLast)
        }
    }

    getDeltaType(delta: Delta | HashDelta, movedFrom?: MoveDestination | undefined) {
        if (typeof delta === 'undefined') {
            if (typeof movedFrom !== 'undefined') {
                return 'movedestination'
            }
            return 'unchanged'
        }
        if (Array.isArray(delta)) {
            if (delta.length === 1 || (delta.length === 3 && delta[2] === 4)) {
                return 'added'
            }
            if (delta.length === 2) {
                return 'modified'
            }
            if ((delta.length === 3 && delta[2] === 0) || (delta.length === 4 && delta[2] === 0 && delta[3] === 0)) {
                return 'deleted'
            }
            if (delta.length === 3 && delta[2] === 2) {
                return 'textdiff'
            }
            if ((delta.length === 3 && delta[2] === 3) || (delta.length === 4 && delta[3] === 3)) {
                return 'moved'
            }
        } else if (typeof delta === 'object') {
            return 'node'
        }
        return 'unknown'
    }

    parseTextDiff(value: string) {
        const output = []
        const lines = value.split('\n@@ ')
        for (let i = 0, l = lines.length; i < l; i++) {
            const line = lines[i]
            const lineOutput: {
                pieces: LineOutputPiece[]
                location?: LineOutputLocation
            } = {
                pieces: [],
            }
            const location = /^(?:@@ )?[-+]?(\d+),(\d+)/.exec(line)?.slice(1)
            const locationLine = location?.[0]
            const locationChr = location?.[1]
            if (locationLine && locationChr) {
                lineOutput.location = {
                    line: locationLine,
                    chr: locationChr,
                }
            }
            const pieces = line.split('\n').slice(1)
            for (let pieceIndex = 0, piecesLength = pieces.length; pieceIndex < piecesLength; pieceIndex++) {
                const piece = pieces[pieceIndex]
                if (!piece.length) {
                    continue
                }
                const pieceOutput: Partial<LineOutputPiece> = {
                    type: 'context',
                }
                if (piece.substring(0, 1) === '+') {
                    pieceOutput.type = 'added'
                } else if (piece.substring(0, 1) === '-') {
                    pieceOutput.type = 'deleted'
                }
                pieceOutput.text = piece.slice(1)
                lineOutput.pieces.push(pieceOutput as LineOutputPiece)
            }
            output.push(lineOutput as LineOutput)
        }
        return output
    }

    abstract rootBegin(context: TContext, type: DeltaType, nodeType: NodeType): void

    abstract rootEnd(context: TContext, type: DeltaType, nodeType: NodeType): void

    abstract nodeBegin(
        context: TContext,
        key: string,
        leftKey: string | number,
        type: DeltaType,
        nodeType: NodeType,
        isLast: boolean,
    ): void

    abstract nodeEnd(
        context: TContext,
        key: string,
        leftKey: string | number,
        type: DeltaType,
        nodeType: NodeType,
        isLast: boolean,
    ): void

    abstract format_unchanged(
        context: TContext,
        delta: undefined,
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ): void

    abstract format_movedestination(
        context: TContext,
        delta: undefined,
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ): void

    abstract format_node(
        context: TContext,
        delta: ObjectDelta | ArrayDelta,
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ): void

    abstract format_added(
        context: TContext,
        delta: AddedDelta | HashArrayAddedDelta,
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ): void

    abstract format_modified(
        context: TContext,
        delta: ModifiedDelta,
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ): void

    abstract format_deleted(
        context: TContext,
        delta: DeletedDelta | HashArrayDeletedDelta,
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ): void

    abstract format_moved(
        context: TContext,
        delta: MovedDelta | HashArrayMovedDelta,
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ): void

    abstract format_textdiff(
        context: TContext,
        delta: TextDiffDelta,
        leftValue: unknown,
        key: string | undefined,
        leftKey: string | number | undefined,
        movedFrom: MoveDestination | undefined,
    ): void
}

export default BaseFormatter
