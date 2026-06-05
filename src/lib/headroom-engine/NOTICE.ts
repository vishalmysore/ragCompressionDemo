/*
 * This module contains JavaScript ports of algorithms from the
 * Headroom context compression library.
 *
 * Original source: https://github.com/chopratejas/headroom
 * Copyright (c) Tejas Chopra and contributors
 * Licensed under the Apache License, Version 2.0
 *
 * Modifications:
 * - Ported from Rust (crates/headroom-core/src/) to TypeScript
 * - Browser-compatible adaptations: MD5 via spark-md5, zlib via pako
 * - No proxy server required; runs entirely client-side
 *
 * You may obtain a copy of the Apache License at:
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Per Apache 2.0 §4(b): this NOTICE file must be retained in all copies.
 * Per Apache 2.0 §4(a): the LICENSE file must accompany any distribution.
 */
export const HEADROOM_ORIGIN = 'https://github.com/chopratejas/headroom'
export const HEADROOM_LICENSE = 'Apache-2.0'
