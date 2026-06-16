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
        
        // 1. 移除视频流中的原生广告投放与追踪
        // Tag 2: adPlacements (广告配置), Tag 3: adSlots (广告位), Tag 8: playbackTracking (广告追踪)
        msg.filter(new Set([2, 3, 8]));
        
        // 2. 解锁后台播放与画中画 (修改播放状态声明)
        // Tag 7: playabilityStatus
        const playabilityStatusField = msg.find(7);
        if (playabilityStatusField && playabilityStatusField.type === 2) {
            const statusMsg = new ProtoMessage(playabilityStatusField.val);
            
            // 将 status (Tag 1) 强行设定为 1 (代表 OK，允许正常渲染与后台播放)
            statusMsg.setVarint(1, 1);
            
            // 剔除任何可能导致客户端弹出“此视频无法在后台播放”或区域限制的报错文本 (Tag 2: reason)
            statusMsg.filter(new Set([2]));
            
            // 重新写回父节点
            playabilityStatusField.val = statusMsg.encode();
        }
        
        return msg.encode();
    }

    /**
     * 核心路由：深度递归净化 /v1/browse (首页、订阅) 与 /v1/next (推荐列表)
     */
    static purgeFeeds(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            let isModified = false;
            
            // 命中信息流广告容器、大黄蜂横幅推广以及 Shorts 短视频组件的底层 Tag
            // 根据 InnerTube 常规映射，Tag 9, 10, 14, 50, 51 常用于存放此类货架渲染器
            const targetBlacklist = new Set([9, 10, 14, 50, 51]);
            
            const originCount = msg.fields.length;
            msg.filter(targetBlacklist);
            if (msg.fields.length !== originCount) isModified = true;
            
            // 深度遍历：如果子节点是 Length-delimited 且有内容，递归进去清洗
            for (const field of msg.fields) {
                if (field.type === 2 && field.val.length > 0) {
                    const cleanedSubBytes = YouTubeProcessor.purgeFeeds(field.val);
                    // 如果内容发生变化，说明子节点中裁切了广告，将其写回
                    if (cleanedSubBytes !== field.val) {
                        field.val = cleanedSubBytes;
                        isModified = true;
                    }
                }
            }
            
            return isModified ? msg.encode() : buffer;
        } catch (e) {
            // 如果遇到纯文本 String 节点引发解析报错，安全放行，不破坏原数据
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
            $.log("正在处理播放器数据 (/v1/player)...");
            modifiedBody = YouTubeProcessor.processPlayer(rawBody);
        } 
        else if (url.includes("/v1/browse") || url.includes("/v1/next") || url.includes("/v1/search")) {
            $.log(`正在净化流媒体数据 (${url.split('/v1/')[1].split('?')[0]})...`);
            modifiedBody = YouTubeProcessor.crunchFeeds(rawBody); // 调用深度清洗
        }

        if (modifiedBody) {
            $.done({ body: modifiedBody });
        } else {
            $.done({});
        }
    } catch (err) {
        $.log(`处理时发生致命异常: ${err.message}`);
        // 异常捕获必须执行空done放行，否则会导致 YouTube 客户端出现网络错误、无限菊花
        $.done({});
    }
})();

// 映射别名兼容
YouTubeProcessor.crunchFeeds = YouTubeProcessor.purgeFeeds;
