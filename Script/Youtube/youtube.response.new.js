/*
 * YouTube 净化与全功能增强脚本 (重构易读版)
 * 支持功能：去视频广告、净化首页/推荐流（无广告与 Shorts 货架）、解锁后台播放与画中画(PiP)
 * 兼容环境：Surge, Shadowrocket, Quantumult X, Loon
 */

// ==================== 1. 跨平台环境适配层 ====================
const $ = {
    isSurge: typeof $environment !== "undefined" && $environment["surge-version"],
    isQuantX: typeof $task !== "undefined",
    isLoon: typeof $loon !== "undefined",
    log: (msg) => console.log(`[YT-Enhance] ${msg}`),
    // 统一获取二进制响应体
    getResponseBody: () => {
        if (typeof $response === "undefined" || !$response.body) return null;
        if ($.isQuantX) {
            // Quantumult X 的 body 可能是 Uint8Array 或 ArrayBuffer
            return typeof $response.body === "string" ? null : new Uint8Array($response.body);
        }
        return new Uint8Array($response.body);
    },
    // 统一完成回调
    done: (data) => {
        if (data && data.body) {
            if ($.isQuantX) {
                $done({ body: data.body.buffer });
            } else {
                $done({ body: data.body });
            }
        } else {
            $done({});
        }
    }
};

// ==================== 2. 轻量级 Protobuf 核心解包/封包类 ====================
class ProtoMessage {
    constructor(buffer) {
        this.fields = []; // 存放解析后的节点 { tag, type, val }
        if (buffer) this.decode(buffer);
    }

    /**
     * 将二进制数据流解码为结构化对象数组
     */
    decode(buffer) {
        let pos = 0;
        const len = buffer.length;
        while (pos < len) {
            // 读取 Varint 格式的 Key
            let key = 0, shift = 0, b;
            do {
                b = buffer[pos++];
                key |= (b & 0x7F) << shift;
                shift += 7;
            } while (b & 0x80);

            const tag = key >> 3;       // 字段标识 ID
            const type = key & 0x07;    // 传输类型 (Wire Type)
            let val;

            if (type === 0) { // Varint 变长整数 (包含 bool, enum)
                let start = pos;
                while (buffer[pos++] & 0x80) {}
                val = buffer.subarray(start, pos); 
            } else if (type === 1) { // 64-bit 固定长度
                val = buffer.subarray(pos, pos + 8);
                pos += 8;
            } else if (type === 2) { // Length-delimited 长度限定类型 (String, Embedded Message, Bytes)
                let l = 0, lShift = 0, lb;
                do {
                    lb = buffer[pos++];
                    l |= (lb & 0x7F) << lShift;
                    lShift += 7;
                } while (lb & 0x80);
                val = buffer.subarray(pos, pos + l);
                pos += l;
            } else if (type === 5) { // 32-bit 固定长度
                val = buffer.subarray(pos, pos + 4);
                pos += 4;
            } else {
                throw new Error(`遇到未知的 Wire Type ${type}，位于偏移量：${pos}`);
            }

            this.fields.push({ tag, type, val });
        }
    }

    /**
     * 将结构化对象重新序列化为标准的二进制 Protobuf 数据流
     */
    encode() {
        const chunks = [];
        for (const f of this.fields) {
            // 写入 Key
            let key = (f.tag << 3) | f.type;
            while (key > 0x7F) {
                chunks.push((key & 0x7F) | 0x80);
                key >>>= 7;
            }
            chunks.push(key & 0x7F);

            // 如果是类型 2，需要先写入后续数据的总长度
            if (f.type === 2) {
                let l = f.val.length;
                while (l > 0x7F) {
                    chunks.push((l & 0x7F) | 0x80);
                    l >>>= 7;
                }
                chunks.push(l & 0x7F);
            }
            
            // 写入字段主体二进制数据
            for (let i = 0; i < f.val.length; i++) {
                chunks.push(f.val[i]);
            }
        }
        return new Uint8Array(chunks);
    }

    // 查找指定 Tag 的首个节点
    find(tag) {
        return this.fields.find(f => f.tag === tag);
    }

    // 根据黑名单批量剔除节点
    filter(tagsSet) {
        this.fields = this.fields.filter(f => !tagsSet.has(f.tag));
    }

    // 强行写入或覆写一个 Varint 值 (例如将状态码改为 1)
    setVarint(tag, value) {
        const chunks = [];
        let val = value;
        while (val > 0x7F) {
            chunks.push((val & 0x7F) | 0x80);
            val >>>= 7;
        }
        chunks.push(val & 0x7F);
        const rawBytes = new Uint8Array(chunks);

        const existing = this.find(tag);
        if (existing) {
            existing.type = 0;
            existing.val = rawBytes;
        } else {
            this.fields.push({ tag, type: 0, val: rawBytes });
        }
    }
}

// ==================== 3. YouTube 业务逻辑处理器 ====================
class YouTubeProcessor {
    /**
     * 核心路由：解析 /v1/player 接口 (控制播放器权限与广告)
     */
    static processPlayer(buffer) {
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
    }

    /**
     * 修复版：针对 /v1/browse (首页、订阅、搜索) 进行非破坏性黑名单过滤
     */
    static purgeBrowse(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            let isModified = false;
            
            // 1. 安全向下纵深骨架层，不改动同级任何其他控制节点
            for (const field of msg.fields) {
                if (field.type === 2 && (field.tag === 1 || field.tag === 3 || field.tag === 4)) {
                    const cleaned = YouTubeProcessor.purgeBrowse(field.val);
                    if (cleaned.length !== field.val.length) {
                        field.val = cleaned;
                        isModified = true;
                    }
                }
            }

            // 2. 采用【非破坏性过滤器】：只将确认是广告或Shorts的元素剔除，其余兄弟节点(如芯片栏、刷新状态)完美保留
            const filteredFields = [];
            let gridChanged = false;

            for (const field of msg.fields) {
                if (field.tag === 1 && field.type === 2) { // richItemRenderer (普通信息流格子)
                    const itemMsg = new ProtoMessage(field.val);
                    const content = itemMsg.find(1);
                    if (content && content.type === 2) {
                        const contentMsg = new ProtoMessage(content.val);
                        // 如果命中明确的广告特征节点 (Tag 5 或 7)，将其剔除
                        if (contentMsg.find(5) || contentMsg.find(7)) {
                            gridChanged = true;
                            continue; 
                        }
                    }
                } 
                else if (field.tag === 2 && field.type === 2) { // richSectionRenderer (全宽货架组合)
                    const sectionMsg = new ProtoMessage(field.val);
                    const content = sectionMsg.find(1);
                    if (content && content.type === 2) {
                        const contentMsg = new ProtoMessage(content.val);
                        // 如果命中 reelShelfRenderer (Tag 8: Shorts短视频组件)，则切除整条货架
                        if (contentMsg.find(8)) {
                            gridChanged = true;
                            continue; 
                        }
                    }
                }
                // 非广告/Shorts 元素，一律原样压入队列保留
                filteredFields.push(field);
            }

            if (gridChanged) {
                msg.fields = filteredFields;
                isModified = true;
            }

            return isModified ? msg.encode() : buffer;
        } catch (e) {
            return buffer;
        }
    }

    /**
     * 修复版：针对 /v1/next (视频下方推荐流) 进行非破坏性精准拦截
     */
    static purgeNext(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            let isModified = false;

            // 1. 安全向下纵深追踪推荐流路径 (仅限骨架 Tag 1 和 2)
            for (const field of msg.fields) {
                if (field.type === 2 && (field.tag === 1 || field.tag === 2)) {
                    const cleaned = YouTubeProcessor.purgeNext(field.val);
                    if (cleaned.length !== field.val.length) {
                        field.val = cleaned;
                        isModified = true;
                    }
                }
            }

            // 2. 在推荐列表容器层，执行精准黑名单过滤
            // Tag 3: 推荐流夹带的 Shorts 货架 (reelShelfRenderer)
            // Tag 11, 12: 推荐流中插播的各种推广与广告图层
            const nextBlacklist = new Set([3, 11, 12]);
            const hasTargetAd = msg.fields.some(f => nextBlacklist.has(f.tag));
            
            if (hasTargetAd) {
                // 仅过滤掉黑名单内的广告/Shorts，无条件保留 playerOverlays(播放控制图层) 等关键同步节点
                msg.fields = msg.fields.filter(f => !nextBlacklist.has(f.tag));
                isModified = true;
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
            $.log("正在解锁播放器权限与去除视频广告...");
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
            // 搜索结果结构与 browse 骨架高度一致，复用安全路由净化
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
