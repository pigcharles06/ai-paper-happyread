import logging
import os
import shutil # Keep for uploads/temp_audio cleanup
import uuid
import fitz  # PyMuPDF
import chromadb # **** Import chromadb ****
from chromadb.config import Settings # **** Import Settings ****
from dotenv import load_dotenv
from flask import (Flask, Response, jsonify, render_template, request,
                   send_from_directory)
from langchain.chains import RetrievalQA
from langchain_community.document_loaders import PyMuPDFLoader
from langchain_community.vectorstores import Chroma
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from openai import APIError, OpenAI

# Load environment variables from .env file
load_dotenv()

# --- Logging Configuration ---
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(threadName)s - %(message)s' # Added threadName for clarity
)

# --- Flask App Configuration ---
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['CHROMA_DB_FOLDER'] = 'chroma_db'
app.config['ALLOWED_EXTENSIONS'] = {'pdf'}
app.config['TEMP_FOLDER'] = 'temp_audio' # For temporary audio files

# Ensure required directories exist at startup
for folder_key in ['UPLOAD_FOLDER', 'CHROMA_DB_FOLDER', 'TEMP_FOLDER']:
    folder_path = app.config[folder_key]
    try:
        os.makedirs(folder_path, exist_ok=True)
        logging.info(f"Directory ensured: {folder_path}")
    except OSError as e:
        logging.error(f"Error creating directory {folder_path}: {e}", exc_info=True)
        # Depending on severity, you might want to exit here
        raise


# --- Initialize AI Components (OpenAI Client, LangChain LLM, Embeddings, Vectorstore) ---
openai_api_key = os.getenv("OPENAI_API_KEY")
if not openai_api_key:
    logging.critical("CRITICAL: OPENAI_API_KEY not found in environment variables. Application cannot start.")
    raise ValueError("OPENAI_API_KEY not found.")
else:
    logging.info("OpenAI API Key loaded successfully.")

try:
    # Use the specified model (ensure it exists and your key has access)
    LLM_MODEL_NAME = "gpt-4.1" # As specified by user
    VISION_MODEL_NAME = "gpt-4.1" # Assuming this model handles vision too

    # Embedding model
    embeddings = OpenAIEmbeddings(openai_api_key=openai_api_key)
    # LangChain LLM Wrapper (for RAG, potentially simple chat/translate)
    llm = ChatOpenAI(model_name=LLM_MODEL_NAME, temperature=0, openai_api_key=openai_api_key)
    # Direct OpenAI Client (for TTS, STT, and direct Vision calls if needed)
    openai_client = OpenAI(api_key=openai_api_key)
    logging.info(f"Initialized OpenAI components with model: {LLM_MODEL_NAME}")

    # Vectorstore (ChromaDB)
    vectorstore = Chroma(
        persist_directory=app.config['CHROMA_DB_FOLDER'],
        embedding_function=embeddings
    )
    logging.info(f"ChromaDB initialized/loaded from '{app.config['CHROMA_DB_FOLDER']}'.")

except Exception as e:
    logging.critical(f"CRITICAL: Failed to initialize AI components: {e}", exc_info=True)
    # Application likely cannot function without these.
    raise


# --- Helper Functions ---
def allowed_file(filename):
    """Checks if the uploaded file extension is allowed (PDF)."""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in app.config['ALLOWED_EXTENSIONS']

def process_pdf_for_rag(pdf_path, paper_id):
    """Processes PDF for RAG: loads, splits, embeds, and stores."""
    logging.info(f"Starting RAG processing for PDF: {pdf_path}, Paper ID: {paper_id}")
    try:
        loader = PyMuPDFLoader(pdf_path)
        documents = loader.load()
        if not documents: logging.warning(f"No documents loaded from PDF: {pdf_path}"); return False

        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        texts = text_splitter.split_documents(documents)
        if not texts: logging.warning(f"No text chunks after splitting PDF: {pdf_path}."); return False
        logging.info(f"Split PDF into {len(texts)} chunks.")

        for i, text in enumerate(texts):
            if not hasattr(text, 'metadata') or text.metadata is None: text.metadata = {}
            text.metadata["paper_id"] = paper_id
            # Optional: Add chunk sequence or other metadata if needed later
            # text.metadata["chunk_index"] = i

        # Add documents to ChromaDB
        vectorstore.add_documents(texts)
        # vectorstore.persist() # Persisting might be handled automatically by Chroma or on shutdown. Check Chroma docs.
        logging.info(f"Successfully added {len(texts)} chunks to ChromaDB for paper {paper_id}")
        return True

    except Exception as e:
        logging.error(f"Error during RAG processing for {pdf_path}: {e}", exc_info=True)
        return False

def find_pdf_path(paper_id):
    """Finds the corresponding PDF file path in the uploads folder based on paper_id."""
    if not paper_id or not isinstance(paper_id, str): return None
    try:
        # Ensure paper_id format is safe before using in path operations
        # Basic check - might need more robust validation depending on UUID format used
        uuid.UUID(paper_id)

        uploads_folder = app.config['UPLOAD_FOLDER']
        for filename in os.listdir(uploads_folder):
            # Robust check: starts with ID, has underscore, ends with .pdf (case-insensitive)
            if filename.startswith(paper_id + "_") and filename.lower().endswith('.pdf'):
                full_path = os.path.join(uploads_folder, filename)
                if os.path.isfile(full_path): # Ensure it's a file
                    return full_path
        logging.warning(f"No PDF file found starting with ID: {paper_id} in {uploads_folder}")
    except ValueError:
        logging.warning(f"Invalid paper_id format received: {paper_id}")
    except Exception as e:
        logging.error(f"Error finding PDF for paper_id {paper_id}: {e}")
    return None

def get_page_text(pdf_path, page_number):
    """Extracts text from a specific page number (1-based) using PyMuPDF."""
    if not pdf_path or not os.path.exists(pdf_path) or page_number < 1:
        logging.warning(f"Invalid path or page number for get_page_text: {pdf_path}, {page_number}")
        return None
    doc = None # Initialize doc to None
    try:
        doc = fitz.open(pdf_path)
        if page_number > doc.page_count:
            logging.warning(f"Page {page_number} out of bounds ({doc.page_count} pages).")
            return None
        page = doc.load_page(page_number - 1) # 0-based index
        text = page.get_text("text") # Extract text
        logging.info(f"Extracted text (len: {len(text or '')}) from page {page_number} of {os.path.basename(pdf_path)}.")
        return text.strip() if text else ""
    except Exception as e:
        logging.error(f"Error extracting text from page {page_number} of {pdf_path}: {e}", exc_info=True)
        return None
    finally:
        if doc: # Ensure document is closed
            doc.close()

# --- Flask Routes ---

@app.route('/')
def index():
    """Renders the main application page."""
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_pdf():
    """Handles PDF file uploads and triggers RAG processing."""
    if 'pdf_file' not in request.files: return jsonify({"error": "請求中缺少檔案部分"}), 400
    file = request.files['pdf_file']
    if not file or not file.filename: return jsonify({"error": "未選擇檔案或檔名為空"}), 400
    if not allowed_file(file.filename): return jsonify({"error": "不允許的檔案類型"}), 400

    paper_id = str(uuid.uuid4())
    # Sanitize original filename before using it
    original_filename = "".join(c for c in os.path.basename(file.filename) if c.isalnum() or c in ['.', '_', '-']).rstrip()
    if not original_filename: original_filename = "uploaded_paper.pdf" # Fallback name
    filename = f"{paper_id}_{original_filename}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    logging.info(f"Attempting to save uploaded file to: {filepath}")

    try:
        file.save(filepath)
        logging.info(f"File saved successfully: {filepath}")
        # Trigger RAG processing (consider background task for large files)
        rag_success = process_pdf_for_rag(filepath, paper_id)
        status_code = 200 if rag_success else 500
        message = "檔案上傳並處理完成！" if rag_success else "檔案已上傳，但 RAG 處理失敗。"
        error_msg = None if rag_success else "RAG 處理失敗。"
        # Return file info needed by frontend
        return jsonify({
            "message": message,
            "error": error_msg,
            "filename": filename,
            "paper_id": paper_id,
            "filepath": f"/pdf/{filename}" # Relative URL for frontend to fetch PDF
        }), status_code

    except Exception as e:
        logging.error(f"Error during file upload or processing: {e}", exc_info=True)
        # Cleanup attempt
        if os.path.exists(filepath):
             try: os.remove(filepath); logging.info(f"Cleaned up partially uploaded file: {filepath}")
             except OSError as remove_err: logging.error(f"Error removing file during cleanup: {remove_err}")
        return jsonify({"error": "上傳或處理過程中發生伺服器錯誤。"}), 500


@app.route('/pdf/<filename>')
def serve_pdf(filename):
    """Serves the PDF file to the frontend viewer."""
    if '..' in filename or filename.startswith('/'): return "無效的檔名", 400
    logging.info(f"Serving PDF file: {filename}")
    try:
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename, as_attachment=False) # inline display
    except FileNotFoundError: logging.warning(f"Requested PDF file not found: {filename}"); return "找不到檔案", 404
    except Exception as e: logging.error(f"Error serving PDF {filename}: {e}"); return "伺服器錯誤", 500


@app.route('/papers')
def get_papers():
    """Gets the list of processed papers suitable for the selection dropdown."""
    logging.info("Request received for paper list.")
    papers = []
    processed_paper_ids = set()
    try:
        logging.info("Querying ChromaDB for distinct paper_ids...")
        results = vectorstore.get(include=["metadatas"]) # Fetch all metadata
        if results and results.get('metadatas'):
            all_metadata = results['metadatas']
            logging.info(f"Retrieved {len(all_metadata)} metadata entries.")
            for meta in all_metadata:
                # Ensure metadata is a dict and has the key
                if isinstance(meta, dict) and 'paper_id' in meta:
                    processed_paper_ids.add(meta['paper_id'])
            logging.info(f"Found {len(processed_paper_ids)} distinct paper IDs in ChromaDB.")
        else: logging.info("No metadata found in ChromaDB.")

        # Match IDs with files in uploads folder to get original names
        if processed_paper_ids:
            paper_id_to_filename = {}
            uploads_folder = app.config['UPLOAD_FOLDER']
            try:
                all_files = os.listdir(uploads_folder)
                for f in all_files:
                     if '_' in f and f.lower().endswith('.pdf'):
                        try: paper_id_part = f.split('_')[0]; uuid.UUID(paper_id_part)
                        except ValueError: continue
                        if paper_id_part in processed_paper_ids and paper_id_part not in paper_id_to_filename:
                             original_name = f.split('_', 1)[1] if len(f.split('_', 1)) > 1 else f
                             paper_id_to_filename[paper_id_part] = original_name
            except Exception as list_err: logging.error(f"Error listing uploads folder: {list_err}")

            # Construct the final list
            for paper_id in processed_paper_ids:
                 display_name = paper_id_to_filename.get(paper_id, f"Paper_{paper_id[:8]}") # Fallback name
                 papers.append({ "paper_id": paper_id, "display_name": display_name })
            papers.sort(key=lambda x: x['display_name']) # Sort alphabetically
            logging.info(f"Constructed paper list with {len(papers)} items.")

    except Exception as e: logging.error(f"Error retrieving paper list: {e}", exc_info=True);
    return jsonify(papers) # Return empty list on error


@app.route('/chat', methods=['POST'])
def handle_chat():
    """Handles chat requests, incorporating current page context and RAG if available."""
    data = request.get_json()
    if not data: return jsonify({"error": "無效的請求負載"}), 400

    user_message = data.get('message')
    paper_id = data.get('paper_id')
    current_page_num_str = data.get('currentPageNum')

    if not user_message: return jsonify({"error": "沒有訊息內容"}), 400

    logging.info(f"Chat req. Paper: {paper_id}, Page: {current_page_num_str}, Msg: '{user_message[:50]}...'")

    try:
        # --- Paper-Specific Chat ---
        if paper_id:
            page_context = ""
            rag_context = ""
            current_page_num = None

            # Validate page number
            if current_page_num_str is not None:
                 try: current_page_num = int(current_page_num_str);
                 except (ValueError, TypeError): logging.warning(f"Invalid page num: {current_page_num_str}"); page_context = "(頁碼無效)"

            # Find PDF and extract page text if applicable
            pdf_path = find_pdf_path(paper_id)
            if not pdf_path:
                 logging.warning(f"PDF not found for paper: {paper_id}"); page_context = "(找不到 PDF 文件)"
            elif current_page_num and current_page_num > 0:
                page_text = get_page_text(pdf_path, current_page_num)
                if page_text is not None: # Handle case where get_page_text returns None on error
                    page_context = f"目前頁面 (頁 {current_page_num}) 內容:\n\"\"\"\n{page_text}\n\"\"\""
                else: page_context = f"(無法提取第 {current_page_num} 頁的內容)"
            elif current_page_num is None:
                 page_context = "(未提供當前頁碼)"

            # Get RAG context
            try:
                logging.info(f"RAG query for {paper_id}"); retriever = vectorstore.as_retriever(search_kwargs={'filter': {'paper_id': paper_id}, 'k': 3})
                relevant_docs = retriever.invoke(user_message)
                if relevant_docs:
                    rag_context_list = [f"--- 文件片段 {i+1} ---\n{doc.page_content}" for i, doc in enumerate(relevant_docs)]
                    rag_context = "**相關文件片段 (供參考):**\n" + "\n\n".join(rag_context_list)
                else: rag_context = "(文件中未找到相關片段)"; logging.info("RAG retrieved 0 documents.")
            except Exception as rag_e: logging.error(f"RAG error: {rag_e}", exc_info=True); rag_context = "(檢索文件片段時出錯)"

            # Construct prompt (ensure page_context and rag_context are defined)
            prompt = f"""用戶正在閱讀一篇論文（ID: {paper_id}）的第 {current_page_num or '?'} 頁。請根據以下資訊回答用戶的問題。主要依據是「目前頁面內容」，若不足或問題較廣泛，再參考「相關文件片段」。

{page_context if page_context else '(無當前頁面內容)'}

{rag_context}

---
用戶問題: {user_message}
---

回答 (請使用繁體中文，並適當使用 Markdown 格式化):
"""
            logging.info(f"Constructed prompt (approx length: {len(prompt)}).")

            # Call LLM (using the initialized llm instance)
            response = llm.invoke(prompt)
            response_message = response.content if hasattr(response, 'content') else str(response)

        # --- General Chat ---
        else:
            logging.info(f"General chat.")
            response = llm.invoke(user_message)
            response_message = response.content if hasattr(response, 'content') else str(response)

        return jsonify({"reply": response_message})

    # --- Error Handling ---
    except APIError as e: logging.error(f"OpenAI API Error: {e}", exc_info=True); status_code = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"AI 請求失敗：{e.code} - {e.message}"}), status_code
    except Exception as e: logging.error(f"Chat error: {e}", exc_info=True); return jsonify({"error": "處理訊息時發生伺服器錯誤。"}), 500


@app.route('/translate', methods=['POST'])
def translate_text():
    """Translates the provided text using the LLM."""
    data = request.get_json();
    if not data or 'text' not in data: return jsonify({"error": "未提供需翻譯的文本。"}), 400
    text_to_translate = data['text'];
    if not text_to_translate.strip(): return jsonify({"error": "翻譯文本不能為空。"}), 400
    target_language = "繁體中文"; logging.info(f"Translate req: '{text_to_translate[:50]}...' to {target_language}")
    try:
        prompt = f"請將以下文字翻譯成{target_language}。僅輸出翻譯後的文字，不要添加任何額外的引號或說明。\n\n原文:\n'''\n{text_to_translate}\n'''\n\n翻譯:";
        response = llm.invoke(prompt); translation = response.content if hasattr(response, 'content') else str(response)
        translation = translation.strip().strip('"').strip("'").strip(); logging.info("Translate successful.")
        return jsonify({"translation": translation})
    except APIError as e: logging.error(f"Translate API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"翻譯失敗：{e.code} - API 錯誤。"}), status
    except Exception as e: logging.error(f"Translate error: {e}", exc_info=True); return jsonify({"error": "翻譯時發生伺服器錯誤。"}), 500


@app.route('/analyze_page', methods=['POST'])
def analyze_page():
    """Analyzes the image data URL of a PDF page using the specified OpenAI model."""
    data = request.get_json(); 
    if not data: return jsonify({"error": "無效的請求負載"}), 400
    image_data_url = data.get('image_data'); page_num = data.get('page_num', '未知')
    if not image_data_url or not image_data_url.startswith('data:image'): return jsonify({"error": "無效的圖像數據格式"}), 400
    logging.info(f"Analyze page {page_num}. Image length: {len(image_data_url)}")
    prompt = f"分析此圖片（來自研究論文第 {page_num} 頁）中的學術內容（文字、表格、圖表、排版）。提供本頁關鍵資訊的簡潔摘要與解釋。請用繁體中文回答，並使用 Markdown 格式化回答以提高可讀性（例如使用列表、粗體）。"
    try:
        logging.info(f"Sending request to OpenAI Multimodal API ({VISION_MODEL_NAME})...")
        response = openai_client.chat.completions.create(
            model=VISION_MODEL_NAME,
            messages=[ { "role": "user", "content": [ {"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": image_data_url, "detail": "auto"}}, ], } ],
            max_tokens=3000
        )
        if response.choices and response.choices[0].message and response.choices[0].message.content:
            analysis_text = response.choices[0].message.content; logging.info("Analysis received."); return jsonify({"analysis": analysis_text})
        else: logging.error("API response missing content."); return jsonify({"error": "AI 分析回覆內容無效。"}), 500
    except APIError as e: logging.error(f"Analyze API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"AI 分析失敗：{e.code} - API 錯誤。"}), status
    except Exception as e: logging.error(f"Vision API error: {e}", exc_info=True); return jsonify({"error": "使用 AI 分析頁面時發生伺服器錯誤。"}), 500


@app.route('/transcribe', methods=['POST'])
def transcribe_audio():
    """Transcribes audio data using OpenAI Whisper."""
    if 'audio_blob' not in request.files: return jsonify({"error": "請求中缺少音訊檔案"}), 400
    audio_file = request.files['audio_blob'];
    if not audio_file or not audio_file.filename: return jsonify({"error": "未選擇音訊檔案或檔名無效"}), 400
    # Sanitize filename before using it in path
    safe_filename = "".join(c for c in os.path.basename(audio_file.filename) if c.isalnum() or c in ['.', '_', '-']).rstrip()
    if not safe_filename: safe_filename = "upload.tmp" # Fallback temp name
    temp_filename = os.path.join(app.config['TEMP_FOLDER'], f"{uuid.uuid4()}_{safe_filename}")
    try: audio_file.save(temp_filename); logging.info(f"Temp audio saved: {temp_filename}");
    except Exception as save_e: logging.error(f"Failed to save temp audio: {save_e}"); return jsonify({"error": "無法儲存音訊檔案。"}), 500
    try:
        with open(temp_filename, "rb") as audio_data:
            logging.info("Sending to Whisper API...");
            transcription = openai_client.audio.transcriptions.create( model="whisper-1", file=audio_data, language="zh" )
        logging.info("Transcription received."); transcribed_text = transcription.text if hasattr(transcription, 'text') else ''
        return jsonify({"text": transcribed_text})
    except APIError as e: logging.error(f"Whisper API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"語音辨識失敗：{e.code} - API 錯誤。"}), status
    except Exception as e: logging.error(f"Transcription error: {e}", exc_info=True); return jsonify({"error": "語音辨識時發生伺服器錯誤。"}), 500
    finally: 
        if os.path.exists(temp_filename): 
            try: os.remove(temp_filename); logging.info(f"Temp audio removed: {temp_filename}") 
            except OSError as re: logging.error(f"Error removing temp audio: {re}")


@app.route('/synthesize', methods=['POST'])
def synthesize_speech():
    """Synthesizes speech from text using OpenAI TTS."""
    data = request.get_json();
    if not data or 'text' not in data: return jsonify({"error": "未提供用於合成的文本。"}), 400
    text_to_speak = data['text'];
    if not text_to_speak.strip(): return jsonify({"error": "合成文本不能為空。"}), 400
    logging.info(f"TTS request: '{text_to_speak[:50]}...'")
    try:
        response = openai_client.audio.speech.create( model="tts-1", voice="alloy", input=text_to_speak, response_format="mp3" )
        logging.info("TTS audio generated by OpenAI.")
        def generate_audio():
            try: yield from response.iter_bytes(chunk_size=4096); logging.info("Finished streaming TTS audio.")
            except Exception as stream_err: logging.error(f"Error during TTS audio streaming: {stream_err}", exc_info=True)
        return Response(generate_audio(), mimetype="audio/mpeg")
    except APIError as e: logging.error(f"TTS API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"語音合成失敗：{e.code} - API 錯誤。"}), status
    except Exception as e: logging.error(f"TTS error: {e}", exc_info=True); return jsonify({"error": "語音合成時發生伺服器錯誤。"}), 500

# --- *** UPDATED: Clear All Data Route (using existing client + env var) *** ---
@app.route('/clear_data', methods=['POST'])
def clear_all_data():
    """Deletes all uploaded PDFs, temp audio, and resets the ChromaDB database."""
    logging.warning("Received request to clear all data.")
    uploads_path = app.config['UPLOAD_FOLDER']
    chroma_path = app.config['CHROMA_DB_FOLDER']
    temp_audio_path = app.config['TEMP_FOLDER']
    errors = []
    global vectorstore # Reference the global vectorstore

    # --- Reset ChromaDB using its API ---
    try:
        logging.info(f"Attempting to reset ChromaDB via existing client for directory: {chroma_path}")
        if vectorstore is not None:
            # Try to get the underlying client from the LangChain wrapper
            # Common attributes are .client or ._client, might vary by version
            chroma_client = None
            if hasattr(vectorstore, 'client'):
                 chroma_client = vectorstore.client
            elif hasattr(vectorstore, '_client'): # Check private attribute as fallback
                 chroma_client = vectorstore._client

            if chroma_client and hasattr(chroma_client, 'reset'):
                chroma_client.reset() # Call reset on the *existing* client instance
                logging.info(f"ChromaDB reset successfully via existing client.")

                # Re-initialize the global LangChain vectorstore wrapper to point to the now empty DB
                if embeddings:
                    vectorstore = Chroma(persist_directory=chroma_path, embedding_function=embeddings)
                    logging.info("Re-initialized global Chroma vectorstore wrapper after reset.")
                else:
                    logging.error("Embeddings not available, cannot re-initialize vectorstore.")
                    errors.append("無法重新初始化向量資料庫。")
            elif not chroma_client:
                 logging.error("Could not retrieve underlying ChromaDB client from vectorstore wrapper.")
                 errors.append("無法獲取 ChromaDB 客戶端實例來重設。")
            else:
                  logging.error("ChromaDB client does not have a 'reset' method.")
                  errors.append("ChromaDB 客戶端不支持重設操作。")
        else:
            logging.warning("Global vectorstore object is None, skipping ChromaDB reset.")
            # Ensure directory exists if vectorstore was never initialized properly
            os.makedirs(chroma_path, exist_ok=True)

    except Exception as e:
        # Catch potential errors during reset (like permission denied if env var wasn't set correctly)
        msg = f"Error resetting ChromaDB for {chroma_path}: {e}"
        logging.error(msg, exc_info=True)
        errors.append(msg)


    # --- Delete Files in Uploads Directory ---
    # (Logic remains the same)
    try:
        if os.path.exists(uploads_path) and os.path.isdir(uploads_path):
            count = 0;
            for filename in os.listdir(uploads_path):
                file_path = os.path.join(uploads_path, filename)
                try:
                    if os.path.isfile(file_path) or os.path.islink(file_path): os.unlink(file_path); count += 1
                except Exception as e: msg = f"Error deleting file {file_path}: {e}"; logging.error(msg); errors.append(msg)
            logging.info(f"Deleted {count} files from uploads: {uploads_path}")
        else: logging.info(f"Uploads directory not found: {uploads_path}")
        os.makedirs(uploads_path, exist_ok=True)
    except Exception as e: msg = f"Error cleaning uploads dir {uploads_path}: {e}"; logging.error(msg, exc_info=True); errors.append(msg); os.makedirs(uploads_path, exist_ok=True)

    # --- Delete Files in Temp Audio Directory ---
    # (Logic remains the same)
    try:
        if os.path.exists(temp_audio_path) and os.path.isdir(temp_audio_path):
            count = 0
            for filename in os.listdir(temp_audio_path):
                file_path = os.path.join(temp_audio_path, filename)
                try:
                    if os.path.isfile(file_path) or os.path.islink(file_path): os.unlink(file_path); count += 1
                except Exception as e: msg = f"Error deleting temp audio {file_path}: {e}"; logging.error(msg); errors.append(msg)
            logging.info(f"Deleted {count} files from temp audio: {temp_audio_path}")
        else: logging.info(f"Temp audio directory not found: {temp_audio_path}")
        os.makedirs(temp_audio_path, exist_ok=True)
    except Exception as e: msg = f"Error cleaning temp audio dir {temp_audio_path}: {e}"; logging.error(msg, exc_info=True); errors.append(msg); os.makedirs(temp_audio_path, exist_ok=True)


    # --- Return Response ---
    if not errors:
        logging.info("Data clearing completed successfully.")
        return jsonify({"message": "所有論文、音訊和 RAG 資料已成功清除。"}), 200
    else:
        logging.error(f"Data clearing completed with errors: {errors}")
        return jsonify({"error": "清除部分資料時發生錯誤。", "details": errors}), 500

# --- Main Execution ---
if __name__ == '__main__':
    logging.info("Starting Flask development server...")
    # Set debug=False for production
    app.run(debug=True, host='0.0.0.0', port=5000)