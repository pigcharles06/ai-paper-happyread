import logging
import os
import shutil
import uuid
import fitz  # PyMuPDF
import chromadb
from dotenv import load_dotenv
from flask import (Flask, Response, jsonify, render_template, request,
                   send_from_directory)
from langchain.chains import RetrievalQA
# *** UPDATED Chroma Import ***
from langchain_chroma import Chroma
from langchain_community.document_loaders import PyMuPDFLoader
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from openai import APIError, OpenAI

# Load environment variables
load_dotenv()

# --- Logging Configuration ---
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - [%(threadName)s] - %(message)s'
)

# --- Flask App Configuration ---
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['CHROMA_DB_FOLDER'] = 'chroma_db'
app.config['ALLOWED_EXTENSIONS'] = {'pdf'}
app.config['TEMP_FOLDER'] = 'temp_audio'

# --- Global Variables & Setup ---
for folder_key in ['UPLOAD_FOLDER', 'CHROMA_DB_FOLDER', 'TEMP_FOLDER']:
    folder_path = app.config[folder_key]
    os.makedirs(folder_path, exist_ok=True)
    logging.info(f"Directory ensured: {folder_path}")

# --- Initialize AI Components (Globally) ---
openai_api_key = os.getenv("OPENAI_API_KEY")
if not openai_api_key:
    logging.critical("CRITICAL: OPENAI_API_KEY not found.")
    raise ValueError("OPENAI_API_KEY not found.")
else:
    logging.info("OpenAI API Key loaded.")

# Initialize globals to None initially
vectorstore: Chroma | None = None # Add type hint
embeddings: OpenAIEmbeddings | None = None
llm: ChatOpenAI | None = None
openai_client: OpenAI | None = None
LLM_MODEL_NAME = "gpt-4.1"
VISION_MODEL_NAME = "gpt-4.1" # Assuming same model

def initialize_ai_components():
    """
    Initializes or re-initializes AI components.
    Returns True on success, False on failure.
    """
    global vectorstore, embeddings, llm, openai_client
    logging.info("Attempting to initialize AI components...")
    try:
        # Ensure components are re-initialized cleanly
        vectorstore = None
        embeddings = None
        llm = None
        openai_client = None

        LLM_MODEL_NAME = "gpt-4.1"
        VISION_MODEL_NAME = "gpt-4.1" # Assuming same model

        embeddings = OpenAIEmbeddings(openai_api_key=openai_api_key)
        llm = ChatOpenAI(model_name=LLM_MODEL_NAME, temperature=0, openai_api_key=openai_api_key)
        openai_client = OpenAI(api_key=openai_api_key)
        logging.info(f"Initialized OpenAI parts (model: {LLM_MODEL_NAME})")

        # Initialize ChromaDB Vectorstore using the new import
        vectorstore = Chroma(
            persist_directory=app.config['CHROMA_DB_FOLDER'],
            embedding_function=embeddings
        )
        logging.info(f"Chroma vectorstore initialized for '{app.config['CHROMA_DB_FOLDER']}'.")
        return True # Success
    except Exception as e:
        logging.critical(f"CRITICAL: AI components init failed: {e}", exc_info=True)
        # Reset globals on failure
        vectorstore = None; embeddings = None; llm = None; openai_client = None
        return False # Failure

# --- Initial call ---
# We attempt initialization here, but routes will also check and re-attempt if needed.
initialize_ai_components()

# --- Helper Function: Ensure AI Components ---
def ensure_ai_components():
    """Checks if AI components are initialized, tries to initialize if not."""
    if not vectorstore or not embeddings or not llm or not openai_client:
        logging.warning("AI components not ready, attempting re-initialization...")
        return initialize_ai_components()
    return True

# --- Other Helper Functions ---
def allowed_file(filename):
    """Checks allowed file extension."""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in app.config['ALLOWED_EXTENSIONS']

def process_pdf_for_rag(pdf_path, paper_id):
    """Processes PDF for RAG and persists data."""
    if not ensure_ai_components(): # Check components are ready
        logging.error("Cannot process RAG: AI components not initialized.")
        return False

    logging.info(f"Starting RAG: {pdf_path}, ID: {paper_id}")
    try:
        loader = PyMuPDFLoader(pdf_path); docs = loader.load()
        if not docs: logging.warning(f"No docs: {pdf_path}"); return False
        splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        texts = splitter.split_documents(docs)
        if not texts: logging.warning(f"No chunks: {pdf_path}"); return False
        logging.info(f"Split into {len(texts)} chunks.")
        for text in texts: text.metadata = text.metadata or {}; text.metadata["paper_id"] = paper_id

        vectorstore.add_documents(documents=texts, embedding_function=embeddings) # Use global embeddings
        logging.info(f"Added {len(texts)} chunks for {paper_id} to Chroma.")
        try:
            logging.info("Persisting ChromaDB data...")
            vectorstore.persist() # Explicitly persist
            logging.info("ChromaDB data persisted.")
        except Exception as persist_e:
            logging.error(f"Error persisting ChromaDB data: {persist_e}", exc_info=True)
        return True
    except Exception as e: logging.error(f"RAG error: {e}", exc_info=True); return False

def find_pdf_path(paper_id):
    """Finds PDF file path based on paper_id."""
    if not paper_id or not isinstance(paper_id, str): return None
    try: uuid.UUID(paper_id)
    except ValueError: logging.warning(f"Invalid paper_id format: {paper_id}"); return None
    uploads_folder = app.config['UPLOAD_FOLDER']
    try:
        for filename in os.listdir(uploads_folder):
            if filename.startswith(paper_id + "_") and filename.lower().endswith('.pdf'):
                full_path = os.path.join(uploads_folder, filename)
                if os.path.isfile(full_path): return full_path
        logging.warning(f"No PDF file found for ID: {paper_id} in {uploads_folder}")
    except Exception as e: logging.error(f"Error finding PDF for {paper_id}: {e}")
    return None

def get_page_text(pdf_path, page_number):
    """Extracts text from a specific page number (1-based)."""
    if not pdf_path or not os.path.exists(pdf_path) or page_number < 1: return None
    doc = None
    try:
        doc = fitz.open(pdf_path)
        if page_number > doc.page_count: logging.warning(f"Page {page_number} out of bounds."); return None
        page = doc.load_page(page_number - 1)
        text = page.get_text("text")
        logging.info(f"Extracted text (len: {len(text or '')}) from page {page_number}.")
        return text.strip() if text else ""
    except Exception as e: logging.error(f"Error extracting text page {page_number}: {e}", exc_info=True); return None
    finally:
        if doc: doc.close()

# --- Flask Routes ---

@app.route('/')
def index():
    """Renders the main application page."""
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_pdf():
    """Handles PDF uploads and triggers RAG."""
    if 'pdf_file' not in request.files: return jsonify({"error": "請求中缺少檔案部分"}), 400
    file = request.files['pdf_file']
    if not file or not file.filename: return jsonify({"error": "未選擇檔案或檔名為空"}), 400
    if not allowed_file(file.filename): return jsonify({"error": "不允許的檔案類型"}), 400

    paper_id = str(uuid.uuid4())
    original_filename = "".join(c for c in os.path.basename(file.filename) if c.isalnum() or c in ['.', '_', '-']).rstrip() or "paper.pdf"
    filename = f"{paper_id}_{original_filename}"; filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    logging.info(f"Saving to: {filepath}")
    try:
        file.save(filepath); logging.info("File saved.")
        # Ensure components ready before processing
        if not ensure_ai_components(): return jsonify({"error": "AI 服務初始化失敗，無法處理檔案。"}), 503
        rag_success = process_pdf_for_rag(filepath, paper_id)
        status_code = 200 if rag_success else 500
        message = "檔案上傳並處理完成！" if rag_success else "檔案已上傳，但 RAG 處理失敗。"
        error_msg = None if rag_success else "RAG 處理失敗。"
        return jsonify({"message": message, "error": error_msg, "filename": filename, "paper_id": paper_id, "filepath": f"/pdf/{filename}" }), status_code
    except Exception as e:
        logging.error(f"Upload/Processing error: {e}", exc_info=True)
        if os.path.exists(filepath): 
            try: os.remove(filepath); logging.info(f"Cleaned up file: {filepath}") 
            except OSError as re: logging.error(f"Cleanup error: {re}")
        return jsonify({"error": "上傳過程中發生伺服器錯誤。"}), 500


@app.route('/pdf/<filename>')
def serve_pdf(filename):
    """Serves the uploaded PDF file."""
    if '..' in filename or filename.startswith('/'): return "無效的檔名", 400
    logging.info(f"Serving PDF: {filename}")
    try: return send_from_directory(app.config['UPLOAD_FOLDER'], filename, as_attachment=False)
    except FileNotFoundError: logging.warning(f"PDF not found: {filename}"); return "找不到檔案", 404
    except Exception as e: logging.error(f"Error serving PDF {filename}: {e}"); return "伺服器錯誤", 500


@app.route('/papers')
def get_papers():
    """Gets the list of processed papers."""
    logging.info("Request received for paper list.")
    # Ensure vectorstore is ready before querying
    if not ensure_ai_components() or not vectorstore:
        logging.error("Cannot get papers: Vectorstore not available.")
        return jsonify([]), 503 # Return empty list and indicate service unavailable

    papers = []; processed_paper_ids = set()
    try:
        logging.info("Querying ChromaDB metadata...")
        results = vectorstore.get(include=["metadatas"])
        if results and results.get('metadatas'):
            all_metadata = results['metadatas']; logging.info(f"Retrieved {len(all_metadata)} metadata entries.")
            for meta in all_metadata:
                if isinstance(meta, dict) and 'paper_id' in meta and isinstance(meta['paper_id'], str):
                    processed_paper_ids.add(meta['paper_id'])
            logging.info(f"Found distinct paper IDs: {processed_paper_ids}")
        else: logging.info("No metadata found in ChromaDB.")

        if processed_paper_ids:
            paper_id_to_filename = {}; uploads_folder = app.config['UPLOAD_FOLDER']
            logging.info(f"Scanning uploads folder: {uploads_folder}")
            try:
                all_files = os.listdir(uploads_folder); logging.info(f"Files found: {all_files[:20]}...") # Log first few
                for f in all_files:
                     if '_' in f and f.lower().endswith('.pdf'):
                        try: paper_id_part = f.split('_')[0]; uuid.UUID(paper_id_part)
                        except (ValueError, IndexError): continue
                        if paper_id_part in processed_paper_ids and paper_id_part not in paper_id_to_filename:
                             original_name = f.split('_', 1)[1] if len(f.split('_', 1)) > 1 else f
                             paper_id_to_filename[paper_id_part] = original_name
            except Exception as list_err: logging.error(f"Error scanning uploads: {list_err}")

            for paper_id in processed_paper_ids:
                 display_name = paper_id_to_filename.get(paper_id, f"Paper_{paper_id[:8]}")
                 papers.append({ "paper_id": paper_id, "display_name": display_name })
                 if paper_id not in paper_id_to_filename: logging.warning(f"No filename match for ID: {paper_id}")
            papers.sort(key=lambda x: x['display_name']); logging.info(f"Constructed paper list: {len(papers)} items.")
        else: logging.info("No processed paper IDs found from metadata.")
    except Exception as e: logging.error(f"Error retrieving paper list: {e}", exc_info=True);
    return jsonify(papers) # Return potentially empty list


@app.route('/chat', methods=['POST'])
def handle_chat():
    """Handles chat requests, incorporating context mode, page context, and RAG."""
    # Ensure components are ready
    if not ensure_ai_components() or not llm or not vectorstore:
         return jsonify({"error":"AI服務暫時無法處理您的請求。"}), 503

    data = request.get_json(); 
    if not data: return jsonify({"error": "無效的請求"}), 400
    user_message = data.get('message'); paper_id = data.get('paper_id'); current_page_num_str = data.get('currentPageNum')
    context_mode = data.get('context_mode', 'page');
    if context_mode not in ['page', 'document']: context_mode = 'page'
    if not user_message: return jsonify({"error": "沒有訊息內容"}), 400
    logging.info(f"Chat req. Paper: {paper_id}, Page: {current_page_num_str}, Mode: {context_mode}, Msg: '{user_message[:50]}...'")
    try:
        if paper_id: # --- Paper-Specific Chat ---
            pdf_path = find_pdf_path(paper_id)
            if not pdf_path: logging.warning(f"PDF not found: {paper_id}"); return jsonify({"reply": f"錯誤：找不到論文 ID '{paper_id}' 的文件。"})
            page_context = ""; rag_context = ""; current_page_num = None
            # Get Page Context ONLY if mode is 'page'
            if context_mode == 'page':
                logging.info("Context Mode: page - getting page text.")
                if current_page_num_str is not None:
                    try: current_page_num = int(current_page_num_str);
                    except (ValueError, TypeError): logging.warning(f"Invalid page num: {current_page_num_str}"); page_context = "(頁碼無效)"
                    else:
                         if current_page_num < 1: logging.warning(f"Page num < 1: {current_page_num}"); page_context = "(頁碼無效)"; current_page_num = None
                if current_page_num: page_text = get_page_text(pdf_path, current_page_num); page_context = f"目前頁面 (頁 {current_page_num}) 內容:\n\"\"\"\n{page_text or '(無法提取內容)'}\n\"\"\""
                elif current_page_num is None and current_page_num_str is not None: pass
                else: page_context = "(未提供當前頁碼資訊)"
            else: logging.info("Context Mode: document - skipping page text extraction.")
            # Get RAG Context
            try:
                logging.info(f"RAG query for {paper_id}..."); retriever = vectorstore.as_retriever(search_kwargs={'filter': {'paper_id': paper_id}, 'k': 8}) # Using k=6 as per user's change
                relevant_docs = retriever.invoke(user_message); logging.info(f"RAG got {len(relevant_docs)} docs.")
                if relevant_docs: rag_context_list = [f"--- 文件片段 {i+1} ---\n{doc.page_content}" for i, doc in enumerate(relevant_docs)]; rag_context = "**相關文件片段 (供參考):**\n" + "\n\n".join(rag_context_list)
                else: rag_context = "(文件中未找到相關片段)"
            except Exception as rag_e: logging.error(f"RAG error: {rag_e}", exc_info=True); rag_context = "(檢索文件片段時出錯)"
            # Construct Prompt based on context_mode
            if context_mode == 'page':
                logging.info("Constructing prompt with PAGE context priority.")
                prompt = f"""用戶正在閱讀論文（ID: {paper_id}）的第 {current_page_num or '?'} 頁。請根據以下資訊回答用戶的問題。請"優先"參考「目前頁面內容」，如果頁面內容不足或問題較廣泛，則參考「相關文件片段」以獲得更完整的上下文來回答。\n\n{page_context if page_context else '(無當前頁面內容)'}\n\n{rag_context}\n\n---\n用戶問題: {user_message}\n---\n\n回答 (請使用繁體中文，並適當使用 Markdown):"""
            else: # context_mode == 'document'
                logging.info("Constructing prompt with DOCUMENT context priority.")
                prompt = f"""用戶正在閱讀論文（ID: {paper_id}）。請"主要"根據以下從整篇論文中檢索到的相關片段來回答用戶的問題。除非問題明確指涉特定頁碼但片段未提及，否則應基於這些片段回答。\n\n{rag_context}\n\n---\n用戶問題: {user_message}\n---\n\n回答 (請使用繁體中文，並適當使用 Markdown):"""
            logging.debug(f"Final Prompt for LLM:\n{prompt}")
            response = llm.invoke(prompt); response_message = response.content if hasattr(response, 'content') else str(response)
        else: # --- General Chat ---
            logging.info(f"General chat."); response = llm.invoke(user_message)
            response_message = response.content if hasattr(response, 'content') else str(response)
        return jsonify({"reply": response_message})
    except APIError as e: logging.error(f"Chat API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"AI請求失敗:{e.code}"}), status
    except Exception as e: logging.error(f"Chat error: {e}", exc_info=True); return jsonify({"error": "處理訊息時發生伺服器錯誤。"}), 500

@app.route('/translate', methods=['POST'])
def translate_text():
    if not ensure_ai_components() or not llm: return jsonify({"error":"AI服務暫時無法處理翻譯。"}), 503
    data = request.get_json(); 
    if not data or 'text' not in data: return jsonify({"error": "未提供需翻譯的文本。"}), 400
    text_to_translate = data['text']; 
    if not text_to_translate.strip(): return jsonify({"error": "翻譯文本不能為空。"}), 400
    target_language = "繁體中文"; logging.info(f"Translate req: '{text_to_translate[:50]}...' to {target_language}")
    try: prompt = f"請將以下文字翻譯成{target_language}。僅輸出翻譯後的文字，不要添加任何額外的引號或說明。\n\n原文:\n'''\n{text_to_translate}\n'''\n\n翻譯:"; response = llm.invoke(prompt); translation = response.content if hasattr(response, 'content') else str(response); translation = translation.strip().strip('"').strip("'").strip(); logging.info("Translate successful."); return jsonify({"translation": translation})
    except APIError as e: logging.error(f"Translate API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"翻譯失敗：{e.code} - API 錯誤。"}), status
    except Exception as e: logging.error(f"Translate error: {e}", exc_info=True); return jsonify({"error": "翻譯時發生伺服器錯誤。"}), 500

@app.route('/analyze_page', methods=['POST'])
def analyze_page():
    if not ensure_ai_components() or not openai_client: return jsonify({"error":"AI服務暫時無法處理頁面分析。"}), 503
    data = request.get_json(); 
    if not data: return jsonify({"error": "無效的請求負載"}), 400
    image_data_url = data.get('image_data'); page_num = data.get('page_num', '未知')
    if not image_data_url or not image_data_url.startswith('data:image'): return jsonify({"error": "無效的圖像數據格式"}), 400
    logging.info(f"Analyze page {page_num}. Image length: {len(image_data_url)}")
    prompt = f"分析此圖片（來自研究論文第 {page_num} 頁）中的學術內容（文字、表格、圖表、排版）。提供本頁關鍵資訊的簡潔摘要與解釋。請用繁體中文回答，並使用 Markdown 格式化回答以提高可讀性（例如使用列表、粗體）。"
    try: logging.info(f"Sending request to OpenAI Multimodal API ({VISION_MODEL_NAME})..."); response = openai_client.chat.completions.create( model=VISION_MODEL_NAME, messages=[ { "role": "user", "content": [ {"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": image_data_url, "detail": "auto"}}, ], } ], max_tokens=3000 )
    except APIError as e: logging.error(f"Analyze API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"AI 分析失敗：{e.code} - API 錯誤。"}), status
    except Exception as e: logging.error(f"Vision API error: {e}", exc_info=True); return jsonify({"error": "使用 AI 分析頁面時發生伺服器錯誤。"}), 500
    if response.choices and response.choices[0].message and response.choices[0].message.content: analysis_text = response.choices[0].message.content; logging.info("Analysis received."); return jsonify({"analysis": analysis_text})
    else: logging.error("API response missing content."); return jsonify({"error": "AI 分析回覆內容無效。"}), 500

@app.route('/transcribe', methods=['POST'])
def transcribe_audio():
    if not ensure_ai_components() or not openai_client: return jsonify({"error":"AI服務暫時無法處理語音辨識。"}), 503
    if 'audio_blob' not in request.files: return jsonify({"error": "請求中缺少音訊檔案"}), 400
    audio_file = request.files['audio_blob']; 
    if not audio_file or not audio_file.filename: return jsonify({"error": "未選擇音訊檔案或檔名無效"}), 400
    safe_filename = "".join(c for c in os.path.basename(audio_file.filename) if c.isalnum() or c in ['.', '_', '-']).rstrip() or "upload.tmp"; temp_filename = os.path.join(app.config['TEMP_FOLDER'], f"{uuid.uuid4()}_{safe_filename}")
    try: audio_file.save(temp_filename); logging.info(f"Temp audio saved: {temp_filename}");
    except Exception as save_e: logging.error(f"Failed save temp audio: {save_e}"); return jsonify({"error": "無法儲存音訊檔案。"}), 500
    try:
        with open(temp_filename, "rb") as audio_data: logging.info("Sending to Whisper API with 'zh' hint..."); transcription = openai_client.audio.transcriptions.create( model="whisper-1", file=audio_data, language="zh" )
        logging.info("Transcription received."); transcribed_text = transcription.text if hasattr(transcription, 'text') else ''; logging.info(f"Whisper result: '{transcribed_text}'")
        return jsonify({"text": transcribed_text})
    except APIError as e: logging.error(f"Whisper API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"語音辨識失敗：{e.code} - API 錯誤。"}), status
    except Exception as e: logging.error(f"Transcription error: {e}", exc_info=True); return jsonify({"error": "語音辨識時發生伺服器錯誤。"}), 500
    finally: 
        if os.path.exists(temp_filename): 
            try: os.remove(temp_filename); logging.info(f"Temp audio removed: {temp_filename}") 
            except OSError as re: logging.error(f"Error removing temp audio: {re}")

@app.route('/synthesize', methods=['POST'])
def synthesize_speech():
    if not ensure_ai_components() or not openai_client: return jsonify({"error":"AI服務暫時無法處理語音合成。"}), 503
    data = request.get_json(); 
    if not data or 'text' not in data: return jsonify({"error": "未提供用於合成的文本。"}), 400
    text_to_speak = data['text']; 
    if not text_to_speak.strip(): return jsonify({"error": "合成文本不能為空。"}), 400
    logging.info(f"TTS request: '{text_to_speak[:50]}...'"); 
    try:
        response = openai_client.audio.speech.create( model="tts-1", voice="alloy", input=text_to_speak, response_format="mp3" ); logging.info("TTS audio generated.")
        def generate_audio(): yield from response.iter_bytes(chunk_size=4096); logging.info("Finished streaming TTS.")
        return Response(generate_audio(), mimetype="audio/mpeg")
    except APIError as e: logging.error(f"TTS API Error: {e}", exc_info=True); status = e.status_code if hasattr(e, 'status_code') else 500; return jsonify({"error": f"語音合成失敗：{e.code} - API 錯誤。"}), status
    except Exception as e: logging.error(f"TTS error: {e}", exc_info=True); return jsonify({"error": "語音合成時發生伺服器錯誤。"}), 500

@app.route('/clear_data', methods=['POST'])
def clear_all_data():
    """Deletes uploads, temp audio, and resets ChromaDB."""
    logging.warning("Received request to clear all data."); uploads_path = app.config['UPLOAD_FOLDER']; chroma_path = app.config['CHROMA_DB_FOLDER']; temp_audio_path = app.config['TEMP_FOLDER']; errors = []; global vectorstore
    # Reset ChromaDB
    try:
        logging.info(f"Attempting reset ChromaDB: {chroma_path}")
        if os.path.exists(chroma_path): from chromadb.config import Settings; chroma_client_for_reset = chromadb.PersistentClient(path=chroma_path, settings=Settings(allow_reset=True)); chroma_client_for_reset.reset(); logging.info(f"ChromaDB reset successfully.")
        else: logging.info(f"ChromaDB dir not found."); os.makedirs(chroma_path, exist_ok=True)
        # Re-initialize global vectorstore
        if embeddings: vectorstore = Chroma(persist_directory=chroma_path, embedding_function=embeddings); logging.info("Re-initialized global vectorstore.")
        else: logging.error("Embeddings missing, cannot re-init vectorstore."); errors.append("無法重新初始化向量庫。")
    except Exception as e: msg = f"Error resetting ChromaDB: {e}"; logging.error(msg, exc_info=True); errors.append(msg); os.makedirs(chroma_path, exist_ok=True)
    # Delete Uploads
    try:
        if os.path.exists(uploads_path): count=0; logging.info(f"Clearing uploads: {uploads_path}"); [ (os.unlink(fp), count := count + 1) for fn in os.listdir(uploads_path) if os.path.isfile(fp := os.path.join(uploads_path, fn)) or os.path.islink(fp) ]; logging.info(f"Deleted {count} files from uploads.")
        else: logging.info(f"Uploads dir not found."); os.makedirs(uploads_path, exist_ok=True)
    except Exception as e: msg = f"Error cleaning uploads: {e}"; logging.error(msg, exc_info=True); errors.append(msg); os.makedirs(uploads_path, exist_ok=True)
    # Delete Temp Audio
    try:
        if os.path.exists(temp_audio_path): count=0; logging.info(f"Clearing temp audio: {temp_audio_path}"); [ (os.unlink(fp), count := count + 1) for fn in os.listdir(temp_audio_path) if os.path.isfile(fp := os.path.join(temp_audio_path, fn)) or os.path.islink(fp) ]; logging.info(f"Deleted {count} files from temp audio.")
        else: logging.info(f"Temp audio dir not found."); os.makedirs(temp_audio_path, exist_ok=True)
    except Exception as e: msg = f"Error cleaning temp audio: {e}"; logging.error(msg, exc_info=True); errors.append(msg); os.makedirs(temp_audio_path, exist_ok=True)
    # Return Response
    if not errors: logging.info("Data clear OK."); return jsonify({"message": "所有資料已成功清除。"}), 200
    else: logging.error(f"Data clear ERR: {errors}"); return jsonify({"error": "清除部分資料時發生錯誤。", "details": errors}), 500

# --- Main Execution ---
if __name__ == '__main__':
    logging.info("Starting Flask development server...")
    # Initial AI component initialization is done globally now
    if not vectorstore or not embeddings or not llm or not openai_client:
         logging.warning("Initial AI component loading might have failed. Check logs.")
         # Optionally exit if critical components failed: exit(1)
    app.run(debug=True, host='0.0.0.0', port=5000)