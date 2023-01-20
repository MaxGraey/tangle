const WASM_PAGE_SIZE = 65536;

enum WasmActionType {
    Store,
    Grow,
    GlobalSet
}

type Store = {
    action_type: WasmActionType.Store,
    location: number,
    old_value: Uint8Array
};

type Grow = {
    action_type: WasmActionType.Grow,
    old_page_count: number,
};

type GlobalSet = {
    action_type: WasmActionType.GlobalSet,
    global_id: string,
    old_value: any,
};

type WasmAction = Store | Grow | GlobalSet;

type TimeStamp = {
    time: number,
    offset: number,
    player_id: number,
};

function time_stamp_less_than(a: TimeStamp, b: TimeStamp): boolean {
    return a.time < b.time
        || a.player_id < b.player_id
        || a.offset < b.offset;
}

export type FunctionCall = {
    name: string,
    args: Array<number>,
    actions_length_before: number,
    time_stamp: TimeStamp
};

export class OfflineWarpCore {
    /// The Wasm code used by WarpCore itself.
    static _warpcore_wasm?: WebAssembly.WebAssemblyInstantiatedSource;
    /// The user Wasm that WarpCore is syncing 
    wasm_instance?: WebAssembly.WebAssemblyInstantiatedSource = undefined;
    current_time: number = 0;
    private time_offset: number = 0;
    private _recurring_call_interval: number = 0;
    recurring_call_time: number = 0;
    private _recurring_call_name?: string = "fixed_update";
    private _actions: Array<WasmAction> = [];
    function_calls: Array<FunctionCall> = [];
    private _imports: WebAssembly.Imports = {};

    static async setup(wasm_binary: Uint8Array, imports: WebAssembly.Imports, recurring_call_interval: number): Promise<OfflineWarpCore> {
        // TODO: Support setting the recurring call interval

        let decoder = new TextDecoder();

        let imports_warp_core_wasm: WebAssembly.Imports = {
            env: {
                external_log: function (pointer: number, length: number) {
                    let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
                    const message_data = new Uint8Array(memory.buffer, pointer, length);
                    const decoded_string = decoder.decode(new Uint8Array(message_data));
                    console.log(decoded_string);
                },
                external_error: function (pointer: number, length: number) {
                    let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
                    const message_data = new Uint8Array(memory.buffer, pointer, length);
                    const decoded_string = decoder.decode(new Uint8Array(message_data));
                    console.error(decoded_string);
                }
            }
        };

        OfflineWarpCore._warpcore_wasm ??= await WebAssembly.instantiateStreaming(fetch("warpcore_mvp.wasm"), imports_warp_core_wasm);

        let processed_binary = await process_binary(wasm_binary);

        let warpcore = new OfflineWarpCore();
        warpcore._recurring_call_interval = recurring_call_interval;
        warpcore._imports = imports;

        warpcore._imports.wasm_guardian = {
            on_store: (location: number, size: number) => {
                //  console.log("on_store called: ", location, size);
                let memory = warpcore.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
                let old_value = new Uint8Array(new Uint8Array(memory.buffer, location, size));

                warpcore._actions.push({ action_type: WasmActionType.Store, location: location, old_value: old_value });
            },
            on_grow: (pages: number) => {
                //  console.log("on_grow called: ", pages);
                let memory = warpcore.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
                warpcore._actions.push({ action_type: WasmActionType.Grow, old_page_count: memory.buffer.byteLength / WASM_PAGE_SIZE });
            },
            on_global_set: (id: number) => {
                //  console.log("on_global_set called: ", id);
                let global_id = "wg_global_" + id;
                warpcore._actions.push({ action_type: WasmActionType.GlobalSet, global_id: global_id, old_value: warpcore.wasm_instance?.instance.exports[global_id] });
            },
        };
        let wasm_instance = await WebAssembly.instantiate(processed_binary, warpcore._imports);
        warpcore.wasm_instance = wasm_instance;

        return warpcore;
    }

    /// Restarts the WarpCore with a new memory.
    async reset_with_wasm_memory(new_memory_data: Uint8Array, current_time: number, recurring_call_time: number) {
        let mem = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
        let page_diff = (new_memory_data.byteLength - mem.buffer.byteLength) / WASM_PAGE_SIZE;

        if (page_diff < 0) {
            this.wasm_instance!.instance = await WebAssembly.instantiate(this.wasm_instance!.module, this._imports);
        }

        let old_memory = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
        if (page_diff > 0) {
            old_memory.grow(page_diff);
        }

        new Uint8Array(old_memory.buffer).set(new_memory_data);
        this._actions = [];
        this.function_calls = [];

        this.current_time = current_time;
        this.recurring_call_time = recurring_call_time;
        this.time_offset = 0;
    }

    remove_history_before(time_exclusive: number) {
        // TODO / LEFT OFF: This isn't correctly exclusive.
        let step = 0;
        for (; step < this.function_calls.length; step++) {
            if (this.function_calls[step].time_stamp.time >= time_exclusive) {
                break;
            }
        }
        let first_function = this.function_calls.splice(0, step)[0];

        if (first_function) {
            this._actions.splice(first_function.actions_length_before);
        }
    }

    private async _rollback_to_length(actions_length: number) {
        let memory = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;

        let to_rollback = this._actions.splice(actions_length, this._actions.length - actions_length);
        for (let i = 0; i < to_rollback.length; i++) {
            let action = to_rollback[i];
            switch (action.action_type) {
                case WasmActionType.Store: {
                    let destination = new Uint8Array(memory.buffer, action.location, action.old_value.byteLength);
                    destination.set(action.old_value);
                    break;
                }
                case WasmActionType.Grow: {
                    // The only way to "shrink" a Wasm instance is to construct an entirely new 
                    // one with a new memory.
                    // Hopefully Wasm gets a better way to shrink modules in the future.

                    let new_memory = new WebAssembly.Memory({
                        initial: action.old_page_count
                    });

                    let dest = new Uint8Array(new_memory.buffer);
                    dest.set(new Uint8Array(memory.buffer, 0, new_memory.buffer.byteLength));

                    // TODO: Is `env` correct here?
                    this._imports.env.mem = new_memory;

                    this.wasm_instance!.instance = await WebAssembly.instantiate(this.wasm_instance!.module!, this._imports);
                    break;
                }
                case WasmActionType.GlobalSet: {
                    (this.wasm_instance?.instance.exports[action.global_id] as WebAssembly.Global).value = action.old_value;
                    break;
                }
            }
        }
    }

    async progress_time(time_progressed: number) {
        if (time_progressed <= 0) {
            return;
        }

        if (this._recurring_call_interval == 0) {
            return;
        }

        this.current_time += time_progressed;

        this.time_offset = 0;

        if (!this.current_time) {
        }
        // Trigger all of the recurring calls.
        // TODO: Check if recurring call interval is defined at all.
        while ((this.current_time - this.recurring_call_time) > this._recurring_call_interval) {
            this.time_offset = 0;
            this.recurring_call_time += this._recurring_call_interval;

            if (this._recurring_call_name) {
                // TODO: Real player ID.
                let time_stamp = {
                    time: this.recurring_call_time,
                    offset: 0, // A recurring call should always be the first call
                    player_id: 0
                };
                this.time_offset += 1;
                await this._call_inner(this._recurring_call_name, time_stamp, []);
            }
        }
    }

    private async _call_inner(function_name: string, time_stamp: TimeStamp, args: number[]) {
        // Rewind any function calls that occur after this.
        let i = this.function_calls.length;
        for (; i > 0; i--) {
            let function_call = this.function_calls[i - 1];
            if (time_stamp_less_than(function_call.time_stamp, time_stamp)) {

                if (this.function_calls[i]) {
                    await this._rollback_to_length(this.function_calls[i].actions_length_before);
                }
                break;
            }
        }

        let actions_length_before = this._actions.length;
        (this.wasm_instance?.instance.exports[function_name] as CallableFunction)(...args);

        this.function_calls.splice(i, 0, {
            name: function_name,
            args: args,
            actions_length_before: actions_length_before,
            time_stamp: time_stamp
        });

        // Replay any function calls that occur after this function
        for (let j = i + 1; j < this.function_calls.length; j++) {
            let f = this.function_calls[j];
            let actions_length_before = this._actions.length;
            f.actions_length_before = actions_length_before;

            // Note: It is assumed function calls cannot be inserted with an out-of-order offset by the same peer.
            // If that were true the offset would need to be checked and potentially updated here.

            (this.wasm_instance?.instance.exports[f.name] as CallableFunction)(...f.args);
        }
    }

    next_time_stamp(): TimeStamp {
        return {
            time: this.current_time,
            offset: this.time_offset,
            player_id: 0,
        };
    }

    async call_with_time_stamp(time_stamp: TimeStamp, function_name: string, args: [number]) {
        // TODO: Check for a PlayerId to insert into args
        // TODO: Use a real player ID.
        await this._call_inner(function_name, time_stamp, args);
        this.time_offset += 1;
    }

    /// Call a function but ensure its results do not persist and cannot cause a desync.
    /// This can be used for things like drawing or querying from the Wasm
    async call_and_revert(function_name: string, args: [number]) {
        let actions_length = this._actions.length;
        (this.wasm_instance?.instance.exports[function_name] as CallableFunction)(...args);
        this._rollback_to_length(actions_length);
    }



    // TODO: These are just helpers and aren't that related to the rest of the code in this:
    gzip_encode(data_to_compress: Uint8Array) {
        let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
        let exports = OfflineWarpCore._warpcore_wasm!.instance.exports;

        let pointer = (exports.reserve_space as CallableFunction)(data_to_compress.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_compress.byteLength);
        destination.set(new Uint8Array(data_to_compress));

        (exports.gzip_encode as CallableFunction)();
        let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        console.log("COMPRESSED LENGTH: ", result_data.byteLength);
        console.log("COMPRESSION RATIO: ", data_to_compress.byteLength / result_data.byteLength);
        return result_data;
    }

    gzip_decode(data_to_decode: Uint8Array) {
        let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
        let instance = OfflineWarpCore._warpcore_wasm!.instance.exports;

        let pointer = (instance.reserve_space as CallableFunction)(data_to_decode.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_decode.byteLength);
        destination.set(new Uint8Array(data_to_decode));

        (instance.gzip_decode as CallableFunction)();
        let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        return new Uint8Array(result_data);
    }

    hash(): Uint8Array {
        let data_to_hash = new Uint8Array((this.wasm_instance!.instance.exports.memory as WebAssembly.Memory).buffer);
        return this.hash_data(data_to_hash);
    }
    hash_data(data_to_hash: Uint8Array): Uint8Array {
        let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
        let instance = OfflineWarpCore._warpcore_wasm!.instance.exports;

        let pointer = (instance.reserve_space as CallableFunction)(data_to_hash.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_hash.byteLength);
        destination.set(new Uint8Array(data_to_hash));

        (instance.xxh3_128_bit_hash as CallableFunction)();
        let hashed_result = new Uint8Array(new Uint8Array(memory.buffer, pointer, 16));
        return hashed_result;
    }
}
/// Preprocess the binary to record all persistent state edits.
async function process_binary(wasm_binary: Uint8Array) {
    let length = wasm_binary.byteLength;
    let pointer = (OfflineWarpCore._warpcore_wasm?.instance.exports.reserve_space as CallableFunction)(length);

    let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;

    const data_location = new Uint8Array(memory.buffer, pointer, length);
    data_location.set(new Uint8Array(wasm_binary));
    (OfflineWarpCore._warpcore_wasm?.instance.exports.prepare_wasm as CallableFunction)();

    // TODO: Write these to an output buffer instead of having two calls for them.
    let output_ptr = (OfflineWarpCore._warpcore_wasm?.instance.exports.get_output_ptr as CallableFunction)();
    let output_len = (OfflineWarpCore._warpcore_wasm?.instance.exports.get_output_len as CallableFunction)();
    const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);
    return output_wasm;
}