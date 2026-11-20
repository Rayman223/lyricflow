<?php

namespace App\Services;

use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class SharedSong
{
    public static function rules(string $prefix): array
    {
        $number = fn ($attribute, $value, $fail) => is_int($value) || is_float($value) ? null : $fail(__('community.number'));

        return [
            ...MusicLinks::rules("$prefix.musicLinks"),
            $prefix => ['required', 'array:formatVersion,title,artist,lyrics,music,musicLinks'],
            "$prefix.formatVersion" => ['required', 'integer', Rule::in([1]), function ($attribute, $value, $fail): void {
                if ($value !== 1) {
                    $fail(__('community.invalid_song'));
                }
            }],
            "$prefix.title" => ['required', 'string', 'max:200'],
            "$prefix.artist" => ['present', 'string', 'max:200'],
            "$prefix.lyrics" => ['required', 'string', 'max:100000'],
            "$prefix.music" => ['required', 'array:bpm,beatsPerBar,barsPerLine'],
            "$prefix.music.bpm" => ['required', 'numeric', 'min:1', 'max:1000', $number],
            "$prefix.music.beatsPerBar" => ['required', 'integer', 'min:1', 'max:32', $number],
            "$prefix.music.barsPerLine" => ['required', 'numeric', 'min:0.01', 'max:1000', $number],
        ];
    }

    public static function validate(array $data, bool $musical = true): array
    {
        Validator::make(['content' => $data], self::rules('content'))->validate();
        if (trim($data['title']) === '' || ($musical && ! self::validLyrics($data['lyrics']))) {
            throw ValidationException::withMessages(['content' => __('community.invalid_song')]);
        }

        return $data;
    }

    /** Published lyrics have already passed the musical grammar validator. */
    public static function requiresLineTiming(string $lyrics): bool
    {
        foreach (preg_split('/\r\n|\r|\n/', $lyrics) as $line) {
            if (preg_match('/^\[line ([^\]]+)\]\s*(.*)$/D', trim($line), $match)
                && (trim($match[2]) === '' || preg_match('/(?:^|\s)beats=/', $match[1]))) {
                return true;
            }
        }

        return false;
    }

    public static function validLyrics(string $lyrics): bool
    {
        $block = null;
        $hasLyrics = false;
        $positive = static fn (string $value, float $max): bool => preg_match('/^(?:\d+(?:\.\d+)?|\.\d+)$/D', $value) && (float) $value >= 0.01 && (float) $value <= $max;
        $tempo = static fn (string $value): bool => $positive(rtrim($value, '%'), 1000) && substr_count($value, '%') <= 1 && (! str_contains($value, '%') || str_ends_with($value, '%'));
        foreach (preg_split('/\r\n|\r|\n/', $lyrics) as $line) {
            $text = trim($line);
            if ($text === '') {
                continue;
            }
            if (! str_starts_with($text, '[') || str_starts_with($text, '\\[')) {
                $hasLyrics = true;

                continue;
            }
            if (preg_match('/^\[section=([^\]]+)\]$/D', $text)) {
                continue;
            }
            if (preg_match('/^\[tempo=([^\]]+)\]$/D', $text, $match)) {
                if ($block || ! $tempo($match[1])) {
                    return false;
                }
                $block = '[/tempo]';

                continue;
            }
            if ($text === '[/tempo]' || $text === '[/line]') {
                if ($block !== $text) {
                    return false;
                }
                $block = null;

                continue;
            }
            if (preg_match('/^\[pause (bars|beats|seconds)=([^\]]+)\]$/D', $text, $match)) {
                if (! $positive($match[2], $match[1] === 'seconds' ? 86400 : 1000)) {
                    return false;
                }

                continue;
            }
            if (preg_match('/^\[line ([^\]]+)\]\s*(.*)$/D', $text, $match)) {
                $seen = [];
                foreach (preg_split('/\s+/', $match[1]) as $parameter) {
                    $pair = explode('=', $parameter);
                    if (count($pair) !== 2 || isset($seen[$pair[0]])) {
                        return false;
                    }
                    [$key, $value] = $pair;
                    $seen[$key] = true;
                    if (! match ($key) {
                        'bars', 'beats' => $positive($value, 1000), 'tempo' => $tempo($value), default => false
                    }) {
                        return false;
                    }
                }
                if (isset($seen['bars'], $seen['beats'])) {
                    return false;
                }
                if (trim($match[2]) === '') {
                    if ($block !== null) {
                        return false;
                    }
                    $block = '[/line]';
                } else {
                    $hasLyrics = true;
                }

                continue;
            }

            return false;
        }

        return ! $block && $hasLyrics;
    }
}
