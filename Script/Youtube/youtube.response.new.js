// ==================== 1. 环境适配与工具层 ($) ====================
const $ = {
    log: (msg) => console.log(`[YT-Purge] ${msg}`),
    getResponseBody: () => {
        if (typeof $response !== "undefined" && $response.body) {
            if (typeof $response.body === "string") {
                return new Uint8Array(Array.from($response.body, c => c.charCodeAt(0)));
            }
            return $response.body;
        }
        return null;
    },
    done: (obj) => {
        if (typeof $done !== "undefined") {
            if (obj.body && obj.body instanceof Uint8Array) {
                // 某些环境要求返回二进制或用二进制字符串兼容
                if (typeof $environment !== "undefined" && $environment['qx-size']) {
                    $done({ body: obj.body.buffer });
                } else {
                    $done({ body: String.fromCharCode.apply(null, obj.body) });
                }
            } else {
                $done(obj);
            }
        }
    }
};

// ==================== 2. ProtoBuf 核心解析与编码器 ====================
class ProtoMessage {
    constructor(buffer) {
        this.fields = [];
        if (buffer) this.decode(buffer);
    }

    decode(buffer) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        let offset = 0;

        const readVarint = () => {
            let result = 0, shift = 0, b;
            do {
                b = view.getUint8(offset++);
                result |= (b & 0x7F) << shift;
                shift += 7;
            } while (b & 0x80);
            return result;
        };

        while (offset < buffer.byteLength) {
            const key = readVarint();
            const tag = key >> 3;
            const type = key & 0x07;

            let val;
            if (type === 0) { // Varint
                val = readVarint();
            } else if (type === 2) { // Length-delimited
                const len = readVarint();
                val = buffer.subarray(offset, offset + len);
                offset += len;
            } else if (type === 1) { // Fixed64
                val = buffer.subarray(offset, offset + 8);
                offset += 8;
            } else if (type === 5) { // Fixed32
                val = buffer.subarray(offset, offset + 4);
                offset += 4;
            } else {
                throw new Error(`未知的 WireType: ${type} 在位移处: ${offset}`);
            }
            this.fields.push({ tag, type, val });
        }
    }

    encode() {
        const parts = [];
        const writeVarint = (val) => {
            const buf = [];
            while (val > 127) {
                buf.push((val & 0x7F) | 0x80);
                val >>>= 7;
            }
            buf.push(val);
            return new Uint8Array(buf);
        };

        for (const f of this.fields) {
            parts.push(writeVarint((f.tag << 3) | f.type));
            if (f.type === 0) {
                parts.push(writeVarint(f.val));
            } else if (f.type === 2) {
                parts.push(writeVarint(f.val.byteLength));
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

// ==================== 3. YouTube 业务逻辑处理器 ====================
class YouTubeProcessor {
    /**
     * 核心路由：解析 /v1/player 接口 (控制播放器权限与广告)
     */
    static processPlayer(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            // 移除视频流中的原生广告投放与追踪
            msg.filter(new Set([2, 3, 8]));
            
            // 解锁后台播放与画中画
            const playabilityStatusField = msg.find(7);
            if (playabilityStatusField && playabilityStatusField.type === 2) {
                const statusMsg = new ProtoMessage(playabilityStatusField.val);
                statusMsg.setVarint(1, 1); // 状态强行改为 1 (OK)
                statusMsg.filter(new Set([2])); // 移除限制原因文本
                playabilityStatusField.val = statusMsg.encode();
            }
            return msg.encode();
        } catch (e) {
            return buffer;
        }
    }

    /**
     * 修复版：通过特征探测，精准剥离首页广告与 Shorts
     */
    static purgeBrowse(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            let isModified = false;
            
            for (const field of msg.fields) {
                if (field.type === 2) {
                    if (field.tag === 1) {
                        const subMsg = new ProtoMessage(field.val);
                        // 【特征探测】检查当前 Tag 1 内部是否包含真正的视频渲染器 Tag
                        const hasRenderers = subMsg.fields.some(f => (f.tag === 1 || f.tag === 2) && f.type === 2);
                        const hasTabs = subMsg.fields.some(f => f.tag === 3);
                        
                        if (hasRenderers && !hasTabs) {
                            // 确定当前层为 richGridRenderer.contents (内容容器层)
                            const filteredFields = [];
                            let gridChanged = false;
                            
                            for (const item of subMsg.fields) {
                                if (item.tag === 1 && item.type === 2) { // richItemRenderer
                                    const itemMsg = new ProtoMessage(item.val);
                                    const content = itemMsg.find(1);
                                    if (content && content.type === 2) {
                                        const contentMsg = new ProtoMessage(content.val);
                                        // 过滤广告节点
                                        if (contentMsg.find(5) || contentMsg.find(7)) {
                                            gridChanged = true;
                                            continue;
                                        }
                                    }
                                } else if (item.tag === 2 && item.type === 2) { // richSectionRenderer
                                    const sectionMsg = new ProtoMessage(item.val);
                                    const content = sectionMsg.find(1);
                                    if (content && content.type === 2) {
                                        const contentMsg = new ProtoMessage(content.val);
                                        // 过滤 Shorts 货架
                                        if (contentMsg.find(8)) {
                                            gridChanged = true;
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
                            // 未探测到内容特征，判定为普通骨架层，安全向下递归
                            const cleaned = YouTubeProcessor.purgeBrowse(field.val);
                            if (cleaned.length !== field.val.length) {
                                field.val = cleaned;
                                isModified = true;
                            }
                        }
                    } else if (field.tag === 3 || field.tag === 4) {
                        // 其他已知骨架标签，直接递归
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

    /**
     * 修复版：针对 /v1/next (视频下方推荐流) 进行特征探测过滤，完美兼容 PiP 画中画
     */
    static purgeNext(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            let isModified = false;

            for (const field of msg.fields) {
                if (field.type === 2 && (field.tag === 1 || field.tag === 2)) {
                    const subMsg = new ProtoMessage(field.val);
                    // 【特征探测】检查当前层是否包含推荐流特有的广告或 Shorts 标签 (3, 11, 12)
                    const hasAdsOrShorts = subMsg.fields.some(f => f.tag === 3 || f.tag === 11 || f.tag === 12);
                    
                    if (hasAdsOrShorts) {
                        // 确定为 secondaryResultsRenderer.results 容器层，执行黑名单剔除
                        // 绝不乱删白名单外的内容，以此保护 PiP 画中画所需的 playerOverlays 控制图层
                        subMsg.fields = subMsg.fields.filter(f => f.tag !== 3 && f.tag !== 11 && f.tag !== 12);
                        field.val = subMsg.encode();
                        isModified = true;
                    } else {
                        // 骨架层，继续向下递归
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
            $.log("正在解锁播放器权限与视频广告...");
            modifiedBody = YouTubeProcessor.processPlayer(rawBody);
        } 
        else if (url.includes("/v1/browse")) {
            $.log("正在精准净化首页/订阅流 (移除广告与 Shorts)...");
            modifiedBody = YouTubeProcessor.purgeBrowse(rawBody);
        } 
        else if (url.includes("/v1/next")) {
            $.log("正在精准净化相关视频推荐流 (移除广告与 Shorts)...");
            modifiedBody = YouTubeProcessor.purgeNext(rawBody);
        } 
        else if (url.includes("/v1/search")) {
            $.log("正在精准净化搜索结果流...");
            modifiedBody = YouTubeProcessor.purgeBrowse(rawBody);
        }

        if (modifiedBody) {
            $.done({ body: modifiedBody });
        } else {
            $.done({});
        }
    } catch (err) {
        $.log(`运行时发生异常: ${err.message}`);
        $.done({});
    }
})();

// 映射别名兼容
YouTubeProcessor.crunchFeeds = YouTubeProcessor.purgeFeeds;
