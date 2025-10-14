"""
TTS Provider Abstraction Layer
Allows easy switching between Google TTS and custom TTS services
"""

from abc import ABC, abstractmethod
from typing import List, Tuple, Dict
from dataclasses import dataclass
from google.cloud import texttospeech_v1beta1 as tts
import os


@dataclass
class ChunkTiming:
    """Timing information for a text chunk"""
    chunk_id: int
    start_time: float  # seconds


@dataclass
class TTSResult:
    """Result from TTS synthesis"""
    audio_bytes: bytes
    chunk_timings: List[ChunkTiming]
    duration: float  # total duration in seconds
    provider: str


class TTSProvider(ABC):
    """Abstract base class for TTS providers"""

    @abstractmethod
    def synthesize_with_marks(
        self,
        chunks: List[Dict],  # [{"chunkId": int, "text": str}]
        voice_id: str,
        speed: float = 1.0,
        pitch: float = 0
    ) -> TTSResult:
        """
        Synthesize speech with timing marks for each chunk

        Args:
            chunks: List of text chunks with IDs
            voice_id: Voice identifier
            speed: Speech rate
            pitch: Pitch adjustment

        Returns:
            TTSResult with audio and timing information
        """
        pass


class GoogleTTSProvider(TTSProvider):
    """Google Cloud Text-to-Speech provider"""

    def __init__(self):
        self.client = tts.TextToSpeechClient()

    def synthesize_with_marks(
        self,
        chunks: List[Dict],
        voice_id: str,
        speed: float = 1.0,
        pitch: float = 0
    ) -> TTSResult:
        """
        Synthesize using Google TTS with SSML marks
        """
        # Build SSML with mark tags for each chunk
        ssml_parts = ['<speak>']

        for chunk in chunks:
            chunk_id = chunk['chunkId']
            text = chunk['text']

            # Add mark before each chunk
            ssml_parts.append(f'<mark name="chunk_{chunk_id}"/>')
            ssml_parts.append(text)
            ssml_parts.append(' ')  # Space between chunks

        ssml_parts.append('</speak>')
        ssml_text = ''.join(ssml_parts)

        # Extract language code
        language_code = "-".join(voice_id.split("-")[:2])

        # Build synthesis request
        synthesis_input = tts.SynthesisInput(ssml=ssml_text)

        voice = tts.VoiceSelectionParams(
            language_code=language_code,
            name=voice_id
        )

        audio_config = tts.AudioConfig(
            audio_encoding=tts.AudioEncoding.MP3,
            speaking_rate=max(0.25, min(4.0, speed)),
            pitch=max(-20.0, min(20.0, pitch)),
            sample_rate_hertz=24000
        )

        # Build request with enable_time_pointing
        request = tts.SynthesizeSpeechRequest(
            input=synthesis_input,
            voice=voice,
            audio_config=audio_config,
            enable_time_pointing=[tts.SynthesizeSpeechRequest.TimepointType.SSML_MARK]
        )

        # Synthesize
        response = self.client.synthesize_speech(request=request)

        # Extract timing information from timepoints
        chunk_timings = []

        for timepoint in response.timepoints:
            # Mark names are like "chunk_0", "chunk_5", etc.
            if timepoint.mark_name.startswith('chunk_'):
                chunk_id = int(timepoint.mark_name.split('_')[1])
                # Convert to seconds (timepoint.time_seconds is already in seconds)
                start_time = timepoint.time_seconds
                chunk_timings.append(ChunkTiming(
                    chunk_id=chunk_id,
                    start_time=start_time
                ))

        # Sort by chunk_id to ensure correct order
        chunk_timings.sort(key=lambda x: x.chunk_id)

        # Estimate duration (last mark time + average chunk duration)
        if chunk_timings:
            last_timing = chunk_timings[-1]
            # Rough estimate: add 5 seconds for the last chunk
            duration = last_timing.start_time + 5.0
        else:
            duration = 0.0

        return TTSResult(
            audio_bytes=response.audio_content,
            chunk_timings=chunk_timings,
            duration=duration,
            provider="google"
        )


class CustomTTSProvider(TTSProvider):
    """Placeholder for future custom TTS service"""

    def synthesize_with_marks(
        self,
        chunks: List[Dict],
        voice_id: str,
        speed: float = 1.0,
        pitch: float = 0
    ) -> TTSResult:
        """
        Synthesize using custom TTS service
        TODO: Implement when custom service is ready
        """
        raise NotImplementedError("Custom TTS provider not yet implemented")


# Factory function
def get_tts_provider(provider_name: str = None) -> TTSProvider:
    """
    Get TTS provider instance

    Args:
        provider_name: "google" or "custom" (defaults to env var TTS_PROVIDER)

    Returns:
        TTSProvider instance
    """
    if provider_name is None:
        provider_name = os.getenv("TTS_PROVIDER", "google")

    if provider_name == "google":
        return GoogleTTSProvider()
    elif provider_name == "custom":
        return CustomTTSProvider()
    else:
        raise ValueError(f"Unknown TTS provider: {provider_name}")
