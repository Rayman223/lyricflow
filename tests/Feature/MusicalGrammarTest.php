<?php

namespace Tests\Feature;

use App\Services\SharedSong;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class MusicalGrammarTest extends TestCase
{
    #[DataProvider('validCodes')]
    public function test_accepts_line_and_passage_timing(string $lyrics): void
    {
        $this->assertTrue(SharedSong::validLyrics($lyrics));
    }

    public static function validCodes(): array
    {
        return [
            ['[line beats=6] Six beats'],
            ["[line tempo=80% beats=4]\nFirst\n[line bars=2] Second\n[/line]"],
            ["[line bars=2]\n[line beats=.5] Half\n[line tempo=90] Fixed\nAgain\n[/line]"],
            ["[line tempo=90]\nFirst\n[/line]\n[tempo=80%]\nSecond\n[/tempo]"],
            ["[line beats=0.01] Minimum\n[line beats=1000] Maximum"],
            ["[line beats=4]\n[section=Verse]\n\n[pause beats=.5]\n[pause bars=1]\n[pause seconds=5]\nLyrics\n[/line]"],
            ['\\[line beats=6]'."\n".'\\[/line]'],
            ["  [line beats=1.5 tempo=90] Lyrics\r\n[line bars=1]\rNext\r[/line]"],
        ];
    }

    #[DataProvider('invalidCodes')]
    public function test_rejects_invalid_timing(string $lyrics): void
    {
        $this->assertFalse(SharedSong::validLyrics($lyrics));
    }

    public static function invalidCodes(): array
    {
        $cases = [
            ["[/line]\nLyrics"],
            ["[line beats=4]\nLyrics"],
            ["[line beats=4]\nLyrics\n[/tempo]"],
            ["[tempo=90]\nLyrics\n[/line]"],
            ["[line beats=4]\n[line bars=2]\nLyrics\n[/line]\n[/line]"],
            ["[line beats=4]\n[tempo=90]\nLyrics\n[/tempo]\n[/line]"],
            ["[tempo=90]\n[line beats=4]\nLyrics\n[/line]\n[/tempo]"],
            ['[line bars=2 beats=4] Lyrics'],
            ["[line beats=4 bars=2]\nLyrics\n[/line]"],
            ['[line beats=4 beats=6] Lyrics'],
            ['[line tempo=90 tempo=80] Lyrics'],
            ['[line] Lyrics'],
            ["[line ]\nLyrics\n[/line]"],
            ['[line unknown=4] Lyrics'],
            ['[line beats=4=6] Lyrics'],
            ["[line beats=4]\n[section=Verse]\n[/line]"],
        ];
        foreach (['0', '0.001', '1000.01', '-1', 'NaN', 'Infinity', '1,5', '1e2', '2%'] as $value) {
            $cases[] = ["[line beats={$value}] Lyrics"];
            $cases[] = ["[line beats={$value}]\nLyrics\n[/line]"];
        }

        return $cases;
    }
}
