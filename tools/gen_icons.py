# -*- coding: utf-8 -*-
"""
gen_icons.py —— 生成 GoalFlow 全套 PWA 图标（纯 Python，无第三方依赖）
图标：品牌渐变底 + 白色靶心（多目标聚焦的隐喻）
输出：icons/icon-192.png / icon-512.png / icon-maskable-192.png / icon-maskable-512.png / apple-touch-icon.png
运行：python tools/gen_icons.py
"""
import math
import os
import struct
import zlib

TOP = (79, 110, 247)     # #4f6ef7
BOTTOM = (124, 58, 237)  # #7c3aed
WHITE = (255, 255, 255)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')


def mix(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def smooth(edge0, edge1, x):
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def make_pixel_fn(size, maskable):
    """返回 pixel(x, y) -> (r, g, b, a)；maskable 时内容缩小到安全区"""
    half = size / 2.0
    scale = 0.62 if maskable else 1.0   # maskable 安全区（内容占 62%）
    corner = size * 0.22                # 非 maskable 的圆角半径

    def pixel(x, y):
        # 垂直渐变背景
        r, g, b = mix(TOP, BOTTOM, y / max(1, size - 1))

        # 靶心：白色圆环 + 圆点（距离以 half*scale 计）
        d = math.hypot(x - half, y - half) / (half * scale)
        ring = 1.0 - smooth(0.50, 0.545, d) * (1.0 - smooth(0.72, 0.765, d))
        dot = 1.0 - smooth(0.20, 0.245, d)
        w = max(ring, dot)
        r = int(r + (WHITE[0] - r) * w)
        g = int(g + (WHITE[1] - g) * w)
        b = int(b + (WHITE[2] - b) * w)

        # 圆角 alpha（maskable 需要全出血不圆角）
        a = 255
        if not maskable:
            cx = min(x, size - 1 - x)
            cy = min(y, size - 1 - y)
            if cx < corner and cy < corner:
                dd = math.hypot(corner - cx, corner - cy)
                a = int(255 * (1.0 - smooth(corner - 1.5, corner + 0.5, dd)))
        return r, g, b, a

    return pixel


def write_png(path, size, maskable):
    pixel = make_pixel_fn(size, maskable)
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: None
        for x in range(size):
            raw.extend(pixel(x, y))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print('written', path, os.path.getsize(path), 'bytes')


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    write_png(os.path.join(OUT_DIR, 'icon-192.png'), 192, False)
    write_png(os.path.join(OUT_DIR, 'icon-512.png'), 512, False)
    write_png(os.path.join(OUT_DIR, 'icon-maskable-192.png'), 192, True)
    write_png(os.path.join(OUT_DIR, 'icon-maskable-512.png'), 512, True)
    write_png(os.path.join(OUT_DIR, 'apple-touch-icon.png'), 180, False)
    print('all icons generated ->', os.path.abspath(OUT_DIR))


if __name__ == '__main__':
    main()
