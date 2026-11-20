<?php

namespace App\Services;

class Score
{
    public const TUNINGS = ['guitar' => [64, 59, 55, 50, 45, 40], 'bass' => [43, 38, 33, 28]];

    public const DRUMS = [36, 38, 42, 46, 49, 51, 45, 48, 50];

    public static function rules(string $prefix): array
    {
        return [$prefix => ['sometimes', function ($attribute, $value, $fail): void {
            if (! self::structure($value)) {
                $fail('Unsupported score format or technical limit exceeded. Update the app or shorten the score; your local draft is kept.');
            }
        }]];
    }

    public static function structure(mixed $value): bool
    {
        if (! is_array($value) || ! array_is_list($value) || strlen(json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)) > 1000000) {
            return false;
        }
        $ids = [];
        $id = static function ($v) use (&$ids): bool {
            if (! is_string($v) || ! preg_match('/^[\da-f-]{36}$/iD', $v) || isset($ids[$v])) {
                return false;
            }
            $ids[$v] = true;

            return true;
        };
        $object = static fn ($v, $keys) => is_array($v) && ! array_diff(array_keys($v), $keys);
        $list = static fn ($v, $max) => is_array($v) && array_is_list($v) && count($v) <= $max;
        $int = static fn ($v, $min, $max) => is_int($v) && $v >= $min && $v <= $max;
        $text = static fn ($v) => is_string($v) && strlen(mb_convert_encoding($v, 'UTF-16LE', 'UTF-8')) <= 400;
        $events = 0;
        foreach ($value as $a) {
            if (! $object($a, ['id', 'version', 'name', 'tempo', 'numerator', 'denominator', 'key', 'mode', 'bars', 'tracks']) || ! $id($a['id'] ?? null) || ($a['version'] ?? null) !== 1 || ! $text($a['name'] ?? null) || ! (is_int($a['tempo'] ?? null) || is_float($a['tempo'] ?? null)) || ! is_finite((float) $a['tempo']) || ! $int($a['numerator'] ?? null, 1, 32) || ! in_array($a['denominator'] ?? null, [2, 4, 8, 16], true) || ! $int($a['key'] ?? null, -7, 7) || (array_key_exists('mode', $a) && ! in_array($a['mode'], ['major', 'minor'], true)) || ! $list($a['bars'] ?? null, 1000) || ! count($a['bars']) || ! $list($a['tracks'] ?? null, 64)) {
                return false;
            }
            foreach ($a['bars'] as $bar) {
                if (! $id($bar)) {
                    return false;
                }
            }
            foreach ($a['tracks'] as $t) {
                $instrument = $t['instrument'] ?? null;
                if (! $object($t, ['id', 'name', 'instrument', 'staves']) || ! $id($t['id'] ?? null) || ! $text($t['name'] ?? null) || ! in_array($instrument, ['guitar', 'bass', 'piano', 'drums'], true) || ! $list($t['staves'] ?? null, 2) || count($t['staves']) !== ($instrument === 'piano' ? 2 : 1)) {
                    return false;
                }
                foreach ($t['staves'] as $si => $s) {
                    $clef = $instrument === 'drums' ? 'percussion' : ($instrument === 'bass' || $si === 1 ? 'bass' : 'treble');
                    if (! $object($s, ['id', 'clef', 'measures']) || ! $id($s['id'] ?? null) || ($s['clef'] ?? null) !== $clef || ! $list($s['measures'] ?? null, 1000) || count($s['measures']) !== count($a['bars'])) {
                        return false;
                    }
                    foreach ($s['measures'] as $m) {
                        if (! $object($m, ['id', 'voices']) || ! $id($m['id'] ?? null) || ! $list($m['voices'] ?? null, 4) || ! count($m['voices'])) {
                            return false;
                        }
                        foreach ($m['voices'] as $v) {
                            if (! $object($v, ['id', 'events']) || ! $id($v['id'] ?? null) || ! $list($v['events'] ?? null, 512)) {
                                return false;
                            }
                            foreach ($v['events'] as $e) {
                                if (++$events > 30000 || ! $object($e, ['id', 'duration', 'dots', 'triplet', 'notes']) || ! $id($e['id'] ?? null) || ! in_array($e['duration'] ?? null, [1, 2, 4, 8, 16, 32, 64], true) || ! in_array($e['dots'] ?? null, [0, 1, 2], true) || ! is_bool($e['triplet'] ?? null) || ! $list($e['notes'] ?? null, 16)) {
                                    return false;
                                }
                                foreach ($e['notes'] as $n) {
                                    if (! $object($n, ['id', 'pitch', 'spelling', 'tie', 'string', 'fret']) || ! $id($n['id'] ?? null) || ! $int($n['pitch'] ?? null, 0, 127) || ! in_array($n['spelling'] ?? null, ['auto', 'sharp', 'flat'], true) || ! is_bool($n['tie'] ?? null)) {
                                        return false;
                                    }
                                    if (isset(self::TUNINGS[$instrument])) {
                                        if (! $int($n['string'] ?? null, 1, count(self::TUNINGS[$instrument])) || ! $int($n['fret'] ?? null, 0, 24)) {
                                            return false;
                                        }
                                    } elseif (array_key_exists('string', $n) || array_key_exists('fret', $n)) {
                                        return false;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        return true;
    }

    public static function ticks(array $e): float
    {
        return 384 / $e['duration'] * ($e['dots'] === 2 ? 1.75 : ($e['dots'] === 1 ? 1.5 : 1)) * ($e['triplet'] ? 2 / 3 : 1);
    }

    public static function playable(array $a): bool
    {
        if (! self::structure([$a]) || trim($a['name']) === '' || $a['tempo'] < 20 || $a['tempo'] > 300 || ! $a['tracks']) {
            return false;
        }
        $sounding = false;
        foreach ($a['tracks'] as $t) {
            if (trim($t['name']) === '') {
                return false;
            }
            foreach ($t['staves'] as $s) {
                $nextEvents = [];
                for ($vi = 0; $vi < 4; $vi++) {
                    $sequence = [];
                    foreach ($s['measures'] as $m) {
                        array_push($sequence, ...($m['voices'][$vi]['events'] ?? []) ?: [null]);
                    }
                    foreach ($sequence as $index => $event) {
                        if ($event) {
                            $nextEvents[$event['id']] = $sequence[$index + 1]['notes'] ?? [];
                        }
                    }
                }
                foreach ($s['measures'] as $m) {
                    foreach ($m['voices'] as $vi => $v) {
                        if (array_sum(array_map(self::ticks(...), $v['events'])) != $a['numerator'] * 384 / $a['denominator']) {
                            return false;
                        }
                        $triplets = 0;
                        $duration = 0;
                        foreach ($v['events'] as $e) {
                            if ($e['triplet']) {
                                if ($e['dots'] || ($triplets && $duration !== $e['duration'])) {
                                    return false;
                                }
                                $duration = $e['duration'];
                                $triplets = ($triplets + 1) % 3;
                            } elseif ($triplets) {
                                return false;
                            }
                            $pitches = [];
                            $strings = [];
                            foreach ($e['notes'] as $n) {
                                $sounding = true;
                                if (isset($pitches[$n['pitch']])) {
                                    return false;
                                }
                                $pitches[$n['pitch']] = true;
                                if (isset(self::TUNINGS[$t['instrument']])) {
                                    if (isset($strings[$n['string']]) || self::TUNINGS[$t['instrument']][$n['string'] - 1] + $n['fret'] !== $n['pitch']) {
                                        return false;
                                    }
                                    $strings[$n['string']] = true;
                                }
                                if ($t['instrument'] === 'drums' && (! in_array($n['pitch'], self::DRUMS, true) || $n['tie'])) {
                                    return false;
                                }
                                if ($n['tie']) {
                                    $next = $nextEvents[$e['id']];
                                    if (! array_filter($next, fn ($note) => $note['pitch'] === $n['pitch'] && ($note['string'] ?? null) === ($n['string'] ?? null))) {
                                        return false;
                                    }
                                }
                            }
                        }
                        if ($triplets) {
                            return false;
                        }
                    }
                }
            }
        }

        return $sounding;
    }

    // Missing means an old client. An explicit [] is required to remove scores.
    public static function preserve(array $before, array $after): void
    {
        abort_if(! empty($before['arrangements']) && ! array_key_exists('arrangements', $after), 422, 'Update the app before changing a song that contains scores.');
    }
}
