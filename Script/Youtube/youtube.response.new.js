// ==================== 1. 高性能环境适配与工具层 ($) ====================
const $ = {
    log: (msg) => console.log(`[YT-Purge] ${msg}`),
    getResponseBody: () => {
        if (typeof $response === "undefined" || !$response.body) return null;
        if ($response.body instanceof Uint8Array) return $response.body;
        if ($response.body instanceof ArrayBuffer) return new Uint8Array($response.body);
        if (typeof $response.body === "string") {
            const len = $response.body.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = $response.body.charCodeAt(i) & 0xff;
            }
            return bytes;
        }
        return null;
    },
    done: (obj) => {
        if (typeof $done !== "undefined") {
            if (obj.body && obj.body instanceof Uint8Array) {
                if (typeof $environment !== "undefined" && $environment['qx-size']) {
                    $done({ body: obj.body.buffer });
                } else {
                    // 核心修复：采用高效分块（Chunked）转换，每块 8KB，彻底杜绝 64KB 引起的栈溢出崩溃
                    let str = "";
                    const chunk = 8192;
                    for (let i = 0; i < obj.body.length; i += chunk) {
                        str += String.fromCharCode.apply(null, obj.body.subarray(i, i + chunk));
                    }
                    $done({ body: str });
                }
            } else {
                $done(obj);
            }
        }
    }
};

// ==================== 2. 64位无损 ProtoBuf 核心解析与编码器 ====================
class ProtoMessage {
    constructor(buffer) {
        this.fields = [];
        if (buffer) this.decode(buffer);
    }

    decode(buffer) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        let offset = 0;

        // 安全读取 32 位以内的 Varint（仅用于解析 Key 和 Length 长度，绝不用于数据字段）
        const readVarint32 = () => {
            let result = 0, shift = 0, b;
            do {
                b = view.getUint8(offset++);
                result |= (b & 0x7F) << shift;
                shift += 7;
            } while (b & 0x80);
            return result;
        };

        while (offset < buffer.byteLength) {
            const key = readVarint32();
            const tag = key >> 3;
            const type = key & 0x07;

            let val;
            if (type === 0) { // Varint
                // 核心创新：非破坏性原字节保留，不转成数值，完美保全所有 64 位大整数
                const start = offset;
                while (view.getUint8(offset++) & 0x80) {}
                val = buffer.subarray(start, offset);
            } else if (type === 2) { // Length-delimited
                const len = readVarint32();
                val = buffer.subarray(offset, offset + len);
                offset += len;
            } else if (type === 1) { // Fixed64
                val = buffer.subarray(offset, offset + 8);
                offset += 8;
            } else if (type === 5) { // Fixed32
                val = buffer.subarray(offset, offset + 4);
                offset += 4;
            } else {
                throw new Error(`未知 WireType: ${type} 位移: ${offset}`);
            }
            this.fields.push({ tag, type, val });
        }
    }

    encode() {
        const parts = [];
        const writeVarint32 = (val) => {
            const buf = [];
            while (val > 127) {
                buf.push((val & 0x7F) | 0x80);
                val >>>= 7;
            }
            buf.push(val);
            return new Uint8Array(buf);
        };

        for (const f of this.fields) {
            parts.push(writeVarint32((f.tag << 3) | f.type));
            if (f.type === 0) {
                if (f.val instanceof Uint8Array) {
                    parts.push(f.val); // 保持原样输出，不损坏原数据
                } else {
                    parts.push(writeVarint32(f.val));
                }
            } else if (f.type === 2) {
                parts.push(writeVarint32(f.val.byteLength));
                parts.push(f.val);
            } else {
                parts.push(f.val);
            }
        }

        const totalLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
        const res = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) {
            res.set(p, offset);
            offset += p.byteLength;
        }
        return res;
    }

    find(tag) {
        return this.fields.find(f => f.tag === tag);
    }

    filter(tagSet) {
        this.fields = this.fields.filter(f => !tagSet.has(f.tag));
    }

    setVarint(tag, value) {
        const field = this.find(tag);
        if (field && field.type === 0) {
            field.val = value;
        } else {
            this.fields.push({ tag, type: 0, val: value });
        }
    }
}

// ==================== 3. YouTube 精准业务逻辑层 ====================
class YouTubeProcessor {
    // 净化 /v1/player (控制后台播放画中画与原生视频贴片广告)
    static processPlayer(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            msg.filter(new Set([2, 3, 8])); // 剔除贴片投放流
            
            const playabilityStatusField = msg.find(7);
            if (playabilityStatusField && playabilityStatusField.type === 2) {
                const statusMsg = new ProtoMessage(playabilityStatusField.val);
                statusMsg.setVarint(1, 1); // 强写状态为 OK (1)
                statusMsg.filter(new Set([2])); // 净化区域或版权限制文本
                playabilityStatusField.val = statusMsg.encode();
            }
            return msg.encode();
        } catch (e) {
            return buffer;
        }
    }

    // 净化 /v1/browse 与 /v1/search (首页瀑布流、搜索流、订阅流广告与 Shorts)
    static purgeBrowse(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            let isModified = false;
            
            for (const field of msg.fields) {
                if (field.type === 2) {
                    if (field.tag === 1) {
                        const subMsg = new ProtoMessage(field.val);
                        const hasRenderers = subMsg.fields.some(f => (f.tag === 1 || f.tag === 2) && f.type === 2);
                        const hasTabs = subMsg.fields.some(f => f.tag === 3);
                        
                        if (hasRenderers && !hasTabs) {
                            const filteredFields = [];
                            let gridChanged = false;
                            
                            for (const item of subMsg.fields) {
                                if (item.tag === 1 && item.type === 2) { // richItemRenderer
                                    const itemMsg = new ProtoMessage(item.val);
                                    const content = itemMsg.find(1);
                                    if (content && content.type === 2) {
                                        const contentMsg = new ProtoMessage(content.val);
                                        if (contentMsg.find(5) || contentMsg.find(7)) {
                                            gridChanged = true; // 广告节点
                                            continue;
                                        }
                                    }
                                } else if (item.tag === 2 && item.type === 2) { // richSectionRenderer
                                    const sectionMsg = new ProtoMessage(item.val);
                                    const content = sectionMsg.find(1);
                                    if (content && content.type === 2) {
                                        const contentMsg = new ProtoMessage(content.val);
                                        if (contentMsg.find(8)) {
                                            gridChanged = true; // Shorts 货架
                                            continue;
                                        }
                                    }
                                }
                                filteredFields.push(item);
                            }
                            if (gridChanged) {
                                subMsg.fields = filteredFields;
                                field.val = subMsg.encode();
                                isModified = true;
                            }
                        } else {
                            const cleaned = YouTubeProcessor.purgeBrowse(field.val);
                            if (cleaned.length !== field.val.length) {
                                field.val = cleaned;
                                isModified = true;
                            }
                        }
                    } else if (field.tag === 3 || field.tag === 4) {
                        const cleaned = YouTubeProcessor.purgeBrowse(field.val);
                        if (cleaned.length !== field.val.length) {
                            field.val = cleaned;
                            isModified = true;
                        }
                    }
                }
            }
            return isModified ? msg.encode() : buffer;
        } catch (e) {
            return buffer;
        }
    }

    // 净化 /v1/next (视频播放页下方的相关推荐、评论区穿插广告与 Shorts)
    static purgeNext(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            let isModified = false;

            for (const field of msg.fields) {
                if (field.type === 2 && (field.tag === 1 || field.tag === 2)) {
                    const subMsg = new ProtoMessage(field.val);
                    const hasAdsOrShorts = subMsg.fields.some(f => f.tag === 3 || f.tag === 11 || f.tag === 12);
                    
                    if (hasAdsOrShorts) {
                        subMsg.fields = subMsg.fields.filter(f => f.tag !== 3 && f.tag !== 11 && f.tag !== 12);
                        field.val = subMsg.encode();
                        isModified = true;
                    } else {
                        const cleaned = YouTubeProcessor.purgeNext(field.val);
                        if (cleaned.length !== field.val.length) {
                            field.val = cleaned;
                            isModified = true;
                        }
                    }
                }
            }
            return isModified ? msg.encode() : buffer;
        } catch (e) {
            return buffer;
        }
    }
}

// ==================== 4. 运行时入口点 (Execution) ====================
(() => {
    const url = $request.url;
    const rawBody = $.getResponseBody();

    if (!rawBody) {
        $.done({});
        return;
    }

    try {
        let modifiedBody = null;

        if (url.includes("/v1/player")) {
            $.log("正在处理播放器响应 (解锁权限/去广告)...");
            modifiedBody = YouTubeProcessor.processPlayer(rawBody);
        } 
        else if (url.includes("/v1/browse")) {
            $.log("正在处理首页/订阅流瀑布流 (移除广告/Shorts)...");
            modifiedBody = YouTubeProcessor.purgeBrowse(rawBody);
        } 
        else if (url.includes("/v1/next")) {
            $.log("正在处理相关推荐流 (移除广告/Shorts)...");
            modifiedBody = YouTubeProcessor.purgeNext(rawBody);
        } 
        else if (url.includes("/v1/search")) {
            $.log("正在处理搜索结果流...");
            modifiedBody = YouTubeProcessor.purgeBrowse(rawBody);
        }

        if (modifiedBody) {
            $.done({ body: modifiedBody });
        } else {
            $.done({});
        }
    } catch (err) {
        $.log(`运行时捕获严重异常: ${err.message}`);
        $.done({});
    }
})();
