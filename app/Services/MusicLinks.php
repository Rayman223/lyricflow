<?php

namespace App\Services;

class MusicLinks
{
    public static function rules(string $prefix, bool $draft = false): array
    {
        $rules = [$prefix => ['sometimes', 'array:youtube,youtubeMusic,deezer,spotify']];
        foreach (['youtube', 'youtubeMusic', 'deezer', 'spotify'] as $service) {
            $rules["$prefix.$service"] = ['sometimes', 'string', 'max:2048'];
            if (! $draft) {
                $rules["$prefix.$service"][] = function ($attribute, $value, $fail) use ($service): void {
                    if (! is_string($value) || ! self::valid($service, $value)) {
                        $fail(__('community.invalid_music_link'));
                    }
                };
            }
        }

        return $rules;
    }

    public static function valid(string $service, string $value): bool
    {
        // Match HTML maxlength and JavaScript String.length: UTF-16 code units.
        $length = intdiv(strlen(mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2);
        if ($length > 2048 || preg_match('/[\s\\\\]/u', $value) || ! preg_match('~^https://[a-z0-9.-]+(?::443)?/~i', $value)) {
            return false;
        }
        $url = parse_url($value);
        if (! $url || isset($url['user']) || isset($url['pass']) || (isset($url['port']) && $url['port'] !== 443)) {
            return false;
        }
        $host = strtolower($url['host'] ?? '');
        $path = $url['path'] ?? '';
        // Match URLSearchParams: the first v parameter wins, without PHP's array coercion.
        $video = false;
        foreach (explode('&', $url['query'] ?? '') as $parameter) {
            $pair = explode('=', $parameter, 2);
            if (urldecode($pair[0]) === 'v') {
                $video = (bool) preg_match('/^[a-zA-Z0-9_-]{11}$/D', urldecode($pair[1] ?? ''));
                break;
            }
        }

        return match ($service) {
            'youtube' => (in_array($host, ['youtube.com', 'www.youtube.com', 'm.youtube.com'], true) && (($path === '/watch' && $video) || preg_match('~^/(shorts|live|embed)/[a-zA-Z0-9_-]{11}/?$~D', $path))) || ($host === 'youtu.be' && preg_match('~^/[a-zA-Z0-9_-]{11}/?$~D', $path)),
            'youtubeMusic' => $host === 'music.youtube.com' && $path === '/watch' && $video,
            'deezer' => (in_array($host, ['deezer.com', 'www.deezer.com'], true) && preg_match('~^/(?:[a-z]{2}/)?track/[1-9]\d*/?$~D', $path)) || ($host === 'deezer.page.link' && preg_match('~^/[a-zA-Z0-9]+/?$~D', $path)) || ($host === 'link.deezer.com' && preg_match('~^/s/[a-zA-Z0-9]+/?$~D', $path)),
            'spotify' => ($host === 'open.spotify.com' && preg_match('~^/(?:intl-[a-z]{2}/)?track/[a-zA-Z0-9]{22}/?$~D', $path)) || ($host === 'spotify.link' && preg_match('~^/[a-zA-Z0-9]+/?$~D', $path)),
            default => false,
        };
    }
}
