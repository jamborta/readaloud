"""
FastAPI backend for ReadAloud ebook reader
Provides secure authentication and Google Cloud TTS proxy
"""

from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional
import os
from datetime import datetime, timedelta
from jose import JWTError, jwt
import hashlib
import hmac
from google.cloud import texttospeech
import firebase_admin
from firebase_admin import credentials, firestore
import base64

# Configuration
SECRET_KEY = os.getenv("SECRET_KEY", "your-secret-key-change-this")
INVITATION_CODE = os.getenv("INVITATION_CODE", "")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

# Initialize Firebase Admin
try:
    # Use default credentials from GOOGLE_APPLICATION_CREDENTIALS env var
    firebase_admin.initialize_app()
    # Use the book-store database instead of (default)
    db = firestore.client(database_id='book-store')
    print("✅ Firestore initialized successfully with database: book-store")
except Exception as e:
    print(f"⚠️  Firestore initialization warning: {e}")
    db = None

# Password salt for hashing
PASSWORD_SALT = os.getenv("SECRET_KEY", "your-secret-key-change-this")

# Security
security = HTTPBearer()

# FastAPI app
app = FastAPI(title="ReadAloud API", version="1.0.0")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://jamborta.github.io",
        "http://localhost:8000",
        "http://localhost:8080"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Google Cloud TTS client
tts_client = texttospeech.TextToSpeechClient()


# Models
class UserRegister(BaseModel):
    username: str
    password: str
    invitationCode: str


class UserLogin(BaseModel):
    username: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str


class TTSRequest(BaseModel):
    text: str
    voiceId: str
    speed: float = 1.0
    pitch: float = 0


class Voice(BaseModel):
    id: str
    name: str
    language: str
    gender: str


class BookMetadata(BaseModel):
    title: str
    author: Optional[str] = None
    fileType: str  # 'epub' or 'pdf'
    uploadedAt: Optional[str] = None


class ReadingPosition(BaseModel):
    bookId: str
    paragraphIndex: int
    totalParagraphs: int
    lastRead: Optional[str] = None


# Helper functions
def verify_password(plain_password: str, hashed_password: str) -> bool:
    computed_hash = get_password_hash(plain_password)
    return hmac.compare_digest(computed_hash, hashed_password)


def get_password_hash(password: str) -> str:
    # Use PBKDF2 for password hashing (secure and built-in)
    return hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        PASSWORD_SALT.encode('utf-8'),
        100000  # iterations
    ).hex()


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
            )
        return username
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )


# Routes
@app.get("/")
async def root():
    return {"message": "ReadAloud API", "version": "1.0.0"}


@app.get("/api/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


@app.post("/api/register", response_model=Token)
async def register(user: UserRegister):
    if not db:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database not available",
        )

    # Verify invitation code
    if not INVITATION_CODE or user.invitationCode != INVITATION_CODE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid invitation code",
        )

    # Check if user exists
    user_ref = db.collection('users').document(user.username)
    user_doc = user_ref.get()

    if user_doc.exists:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already exists",
        )

    # Create user in Firestore
    hashed_password = get_password_hash(user.password)
    user_data = {
        "username": user.username,
        "hashed_password": hashed_password,
        "created_at": datetime.now().isoformat(),
        "total_characters_used": 0,
    }
    user_ref.set(user_data)

    # Generate token
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )

    return {"access_token": access_token, "token_type": "bearer"}


@app.post("/api/login", response_model=Token)
async def login(user: UserLogin):
    if not db:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database not available",
        )

    # Get user from Firestore
    user_ref = db.collection('users').document(user.username)
    user_doc = user_ref.get()

    if not user_doc.exists:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )

    user_data = user_doc.to_dict()

    # Verify password
    if not verify_password(user.password, user_data["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )

    # Generate token
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )

    return {"access_token": access_token, "token_type": "bearer"}


@app.get("/api/voices")
async def get_voices(username: str = Depends(verify_token)):
    """Get available TTS voices"""
    voices = [
        # English (US)
        {"id": "en-US-Neural2-A", "name": "US English (Female, Neural)", "language": "en-US", "gender": "FEMALE"},
        {"id": "en-US-Neural2-C", "name": "US English (Male, Neural)", "language": "en-US", "gender": "MALE"},
        {"id": "en-US-Neural2-D", "name": "US English (Male, Neural)", "language": "en-US", "gender": "MALE"},
        {"id": "en-US-Neural2-E", "name": "US English (Female, Neural)", "language": "en-US", "gender": "FEMALE"},
        {"id": "en-US-Neural2-F", "name": "US English (Female, Neural)", "language": "en-US", "gender": "FEMALE"},

        # English (UK)
        {"id": "en-GB-Neural2-A", "name": "UK English (Female, Neural)", "language": "en-GB", "gender": "FEMALE"},
        {"id": "en-GB-Neural2-B", "name": "UK English (Male, Neural)", "language": "en-GB", "gender": "MALE"},
        {"id": "en-GB-Neural2-C", "name": "UK English (Female, Neural)", "language": "en-GB", "gender": "FEMALE"},
        {"id": "en-GB-Neural2-D", "name": "UK English (Male, Neural)", "language": "en-GB", "gender": "MALE"},

        # English (AU)
        {"id": "en-AU-Neural2-A", "name": "Australian English (Female, Neural)", "language": "en-AU", "gender": "FEMALE"},
        {"id": "en-AU-Neural2-B", "name": "Australian English (Male, Neural)", "language": "en-AU", "gender": "MALE"},
        {"id": "en-AU-Neural2-C", "name": "Australian English (Female, Neural)", "language": "en-AU", "gender": "FEMALE"},
        {"id": "en-AU-Neural2-D", "name": "Australian English (Male, Neural)", "language": "en-AU", "gender": "MALE"},

        # English (IN)
        {"id": "en-IN-Neural2-A", "name": "Indian English (Female, Neural)", "language": "en-IN", "gender": "FEMALE"},
        {"id": "en-IN-Neural2-B", "name": "Indian English (Male, Neural)", "language": "en-IN", "gender": "MALE"},
    ]

    return {"voices": voices}


@app.post("/api/synthesize")
async def synthesize(request: TTSRequest, username: str = Depends(verify_token)):
    """Synthesize text to speech using Google Cloud TTS"""

    # Validate input
    if not request.text or len(request.text.strip()) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text cannot be empty",
        )

    if len(request.text) > 5000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text exceeds maximum length of 5000 characters",
        )

    try:
        # Extract language code from voice ID (e.g., "en-US" from "en-US-Neural2-A")
        language_code = "-".join(request.voiceId.split("-")[:2])

        # Build synthesis request
        synthesis_input = texttospeech.SynthesisInput(text=request.text)

        voice = texttospeech.VoiceSelectionParams(
            language_code=language_code,
            name=request.voiceId
        )

        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=max(0.25, min(4.0, request.speed)),
            pitch=max(-20.0, min(20.0, request.pitch)),
            sample_rate_hertz=24000
        )

        # Perform the text-to-speech request
        response = tts_client.synthesize_speech(
            input=synthesis_input,
            voice=voice,
            audio_config=audio_config
        )

        # Encode audio content to base64
        audio_content = base64.b64encode(response.audio_content).decode('utf-8')

        # Track usage in Firestore
        if db:
            user_ref = db.collection('users').document(username)
            user_ref.update({
                "total_characters_used": firestore.Increment(len(request.text))
            })

        return {
            "audioContent": audio_content,
            "characterCount": len(request.text)
        }

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Text-to-speech service error: {str(e)}",
        )


# Book sync endpoints
@app.get("/api/books")
async def get_books(username: str = Depends(verify_token)):
    """Get all book metadata for the user"""
    if not db:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database not available",
        )

    books_ref = db.collection('users').document(username).collection('books')
    books = books_ref.stream()

    book_list = []
    for book in books:
        book_data = book.to_dict()
        book_data['id'] = book.id
        book_list.append(book_data)

    return {"books": book_list}


@app.post("/api/books")
async def save_book(book: BookMetadata, username: str = Depends(verify_token)):
    """Save book metadata"""
    if not db:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database not available",
        )

    books_ref = db.collection('users').document(username).collection('books')

    book_data = book.dict()
    book_data['uploadedAt'] = datetime.now().isoformat()

    # Add book and return the generated ID
    doc_ref = books_ref.add(book_data)

    return {"id": doc_ref[1].id, **book_data}


@app.delete("/api/books/{book_id}")
async def delete_book(book_id: str, username: str = Depends(verify_token)):
    """Delete a book"""
    if not db:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database not available",
        )

    book_ref = db.collection('users').document(username).collection('books').document(book_id)
    book_ref.delete()

    return {"status": "deleted", "id": book_id}


@app.get("/api/positions/{book_id}")
async def get_position(book_id: str, username: str = Depends(verify_token)):
    """Get reading position for a book"""
    if not db:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database not available",
        )

    position_ref = db.collection('users').document(username).collection('positions').document(book_id)
    position_doc = position_ref.get()

    if not position_doc.exists:
        return None

    return position_doc.to_dict()


@app.post("/api/positions")
async def save_position(position: ReadingPosition, username: str = Depends(verify_token)):
    """Save reading position for a book"""
    if not db:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database not available",
        )

    position_ref = db.collection('users').document(username).collection('positions').document(position.bookId)

    position_data = position.dict()
    position_data['lastRead'] = datetime.now().isoformat()

    position_ref.set(position_data)

    return position_data


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
