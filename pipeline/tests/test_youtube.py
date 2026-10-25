import pytest

from labelmeme.youtube import UPLOAD_HINT, SourceError, parse_youtube_url, plain_error

CANONICAL = "https://www.youtube.com/watch?v=R6MlUcmOul8"


@pytest.mark.parametrize(
    "text",
    [
        "https://www.youtube.com/watch?v=R6MlUcmOul8",
        "  https://www.youtube.com/watch?v=R6MlUcmOul8&list=PL123&t=42s  ",
        "https://youtube.com/watch?feature=share&v=R6MlUcmOul8",
        "youtube.com/watch?v=R6MlUcmOul8",
        "https://m.youtube.com/watch?v=R6MlUcmOul8",
        "https://youtu.be/R6MlUcmOul8",
        "https://youtu.be/R6MlUcmOul8?si=abc&t=10",
        "https://www.youtube.com/shorts/R6MlUcmOul8",
        "https://www.youtube.com/embed/R6MlUcmOul8",
        "http://www.youtube.com/watch?v=R6MlUcmOul8",
    ],
)
def test_accepts_youtube_url_shapes(text: str) -> None:
    assert parse_youtube_url(text) == ("R6MlUcmOul8", CANONICAL)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "R6MlUcmOul8",
        "https://vimeo.com/123456",
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/watch?v=R6MlUcmOul8x",
        "https://www.youtube.com/playlist?list=PL123",
        "https://evil.example/watch?v=R6MlUcmOul8",
        "https://youtube.com.evil.example/watch?v=R6MlUcmOul8",
        "javascript:alert(1)",
        "ftp://youtube.com/watch?v=R6MlUcmOul8",
    ],
)
def test_rejects_anything_else(text: str) -> None:
    with pytest.raises(SourceError, match="YouTube video link"):
        parse_youtube_url(text)


@pytest.mark.parametrize(
    ("raw", "plain"),
    [
        ("ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access", "This video is private. " + UPLOAD_HINT),
        ("ERROR: [youtube] abcdefghijk: Video unavailable. This video has been removed", "This video is unavailable. " + UPLOAD_HINT),
        ("ERROR: [youtube] aaaaaaaaaaa: This video is unavailable", "This video is unavailable. " + UPLOAD_HINT),
        ("ERROR: [youtube] abcdefghijk: Sign in to confirm your age.", "This video is age-restricted, so it cannot be downloaded without signing in. " + UPLOAD_HINT),
        ("ERROR: [youtube] abcdefghijk: Requested format is not available.", "This video has no H.264 version at 720p or below. " + UPLOAD_HINT),
        ("ERROR: [youtube] abcdefghijk: Sign in to confirm you're not a bot. Use --cookies", "YouTube is blocking downloads from this server. " + UPLOAD_HINT),
        ("ERROR: [youtube] abcdefghijk: Something new broke", "YouTube said: Something new broke. " + UPLOAD_HINT),
    ],
)
def test_maps_yt_dlp_errors_to_plain_sentences(raw: str, plain: str) -> None:
    assert plain_error(raw) == plain


def test_the_upload_hint_reads_as_its_own_sentence() -> None:
    assert plain_error("Private video") == "This video is private. You can upload the video file instead."
