import type { Delta, HashDelta } from '../types.js'
import Context from './context.js'

class ReverseContext extends Context<Delta | HashDelta> {
    delta: Delta | HashDelta
    pipe: 'reverse'

    nested?: boolean
    newName?: `_${number}`

    constructor(delta: Delta | HashDelta) {
        super()
        this.delta = delta
        this.pipe = 'reverse'
    }
}

export default ReverseContext
